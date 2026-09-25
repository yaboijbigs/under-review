import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import type { Game } from '../packages/core/src/contracts.js';
import { normalizeRow, normalizeSchedule, numberOrNull, type ProviderRow } from '../packages/core/src/normalize.js';
import { extractOfficiatingObservation, hasVerifiedGameOpening, type OfficiatingGameObservation } from '../packages/core/src/officiating-observations.js';
import { checksumBytes, checksumFile, currentPublicSource, publicPbpSource, writeAtomic, type CorpusSource } from './lib/officiating-sources.js';

export const CREW_ROLES = ['Referee', 'Umpire', 'Down Judge', 'Line Judge', 'Field Judge', 'Side Judge', 'Back Judge'] as const;
type CrewRole = typeof CREW_ROLES[number];
export interface CorpusGame {
  game: Game;
  observation: OfficiatingGameObservation;
  crew: { role: CrewRole; name: string }[];
  crewStatus: 'complete' | 'partial' | 'missing' | 'conflict';
  crewIssues: string[];
  playCount: number;
  source: { playByPlayChecksum: string; scheduleChecksum: string; officialsChecksum: string };
}
interface SourceMetadata extends Omit<CorpusSource, 'origin'> {}
const stableSource = ({ origin: _origin, ...source }: CorpusSource): SourceMetadata => source;
const root = process.cwd();
const scheduleUrl = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const arguments_ = process.argv.slice(2);
for (const argument of arguments_) if (!['--download-missing', '--refresh-current-public'].includes(argument) && !/^--seasons=\d{4}(?:-\d{4}|(?:,\d{4})*)$/.test(argument)) throw new Error(`Unknown argument: ${argument}`);
const selected = arguments_.find(argument => argument.startsWith('--seasons='))?.slice('--seasons='.length) ?? '2015-2026';
const seasons = selected.includes('-') ? (() => { const [start, end] = selected.split('-').map(Number); return Array.from({ length: end - start + 1 }, (_, index) => start + index); })() : selected.split(',').map(Number);
if (!seasons.length || seasons.some(season => season < 2015 || season > 2026) || new Set(seasons).size !== seasons.length) throw new Error('Supported corpus seasons: 2015–2026, without duplicates.');
const profiles = JSON.parse(await readFile(path.join(root, 'analytics/models/game-profiles.json'), 'utf8'));
const scheduleHash: string = profiles.sourceChecksums[scheduleUrl];
if (!/^[a-f0-9]{64}$/.test(scheduleHash)) throw new Error('Invalid frozen schedule checksum');
const historicalScheduleBytes = gunzipSync(await readFile(path.join(root, `analytics/models/game-profile-sources/${scheduleHash}.csv.gz`)));
if (checksumBytes(historicalScheduleBytes) !== scheduleHash) throw new Error('Frozen schedule checksum mismatch');
const scheduleMetadata = profiles.sources.find((source: { url: string }) => source.url === scheduleUrl);
const historicalScheduleSource: CorpusSource = { url: scheduleUrl, checksum: scheduleHash, license: 'CC-BY-4.0', attribution: 'Lee Sharpe and nflverse',
  bytes: historicalScheduleBytes.length, retrievedAt: scheduleMetadata.retrievedAt, lastModified: scheduleMetadata.lastModified, etag: scheduleMetadata.etag, origin: 'frozen' };
const targetSchedule = seasons.includes(2026) ? await currentPublicSource(root, 'schedules', arguments_.includes('--refresh-current-public')) : null;
if (seasons.includes(2026) && !targetSchedule) throw new Error('Target season requires a checksum-verified stored schedule snapshot.');
const scheduleMaps = new Map<number, { games: Map<string, Game>; source: CorpusSource }>();
for (const season of seasons) {
  const source = season === 2026 ? targetSchedule!.source : historicalScheduleSource;
  const bytes = season === 2026 ? await readFile(targetSchedule!.file) : historicalScheduleBytes;
  const games = new Map<string, Game>();
  for (const row of parseSync(bytes, { columns: true, bom: true }) as Record<string, string>[]) {
    if (Number(row.season) !== season || row.game_type !== 'REG') continue;
    const game = normalizeSchedule(normalizeRow(row));
    if (games.has(game.id)) throw new Error(`Duplicate schedule game: ${game.id}`);
    games.set(game.id, game);
  }
  scheduleMaps.set(season, { games, source });
}

const officialMetadata = JSON.parse(await readFile(path.join(root, 'packages/core/reference/expectations-officials-source.json'), 'utf8'));
const officialBytes = gunzipSync(await readFile(path.join(root, 'packages/core/reference/expectations-officials.csv.gz')));
if (checksumBytes(officialBytes) !== officialMetadata.checksum) throw new Error('Frozen officials checksum mismatch');
const aliases: Record<string, string> = JSON.parse(await readFile(path.join(root, 'packages/core/reference/expectations-reference.json'), 'utf8')).aliases;
const canonical = (name: unknown): string => { const cleaned = String(name ?? '').trim().replace(/\s+/g, ' '); return aliases[cleaned] ?? cleaned; };
const teamAliases: Record<string, string> = { OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', JAC: 'JAX', WSH: 'WAS' };
const canonicalTeam = (team: string): string => teamAliases[team] ?? team;
function gameTeamNames(play: ProviderRow, game: Game | undefined): ProviderRow {
  if (!game) return play;
  return Object.fromEntries(Object.entries(play).map(([key, value]) => {
    if (typeof value !== 'string' || !/(?:_team$|^posteam$|^defteam$)/.test(key)) return [key, value];
    if (canonicalTeam(value) === canonicalTeam(game.homeTeam)) return [key, game.homeTeam];
    if (canonicalTeam(value) === canonicalTeam(game.awayTeam)) return [key, game.awayTeam];
    return [key, value];
  }));
}
const byGsis = new Map<string, Record<string, string>[]>();
let excludedOfficialRows = 0;
for (const row of parseSync(officialBytes, { columns: true, bom: true }) as Record<string, string>[]) {
  const role = row.position === 'Head Linesman' ? 'Down Judge' : row.position;
  if (!(CREW_ROLES as readonly string[]).includes(role)) { excludedOfficialRows++; continue; }
  const key = String(row.game_key);
  const entries = byGsis.get(key) ?? [];
  entries.push({ ...row, position: role });
  byGsis.set(key, entries);
}
function crewFor(game: Game): Pick<CorpusGame, 'crew' | 'crewStatus' | 'crewIssues'> {
  const rows = byGsis.get(String(game.providerData.gsis ?? '')) ?? [];
  const crew: CorpusGame['crew'] = [], crewIssues: string[] = [];
  for (const role of CREW_ROLES) {
    const matches = rows.filter(row => row.position === role);
    if (matches.some(row => Number(row.season) !== game.season || row.season_type !== game.gameType || Number(row.week) !== game.week)) {
      crewIssues.push(`assignment_identity_conflict:${role}`); continue;
    }
    const names = [...new Set(matches.map(row => canonical(row.official_name)).filter(Boolean))];
    if (names.length > 1) { crewIssues.push(`duplicate_role:${role}`); continue; }
    if (!names.length) continue;
    if (role === 'Referee' && canonical(game.providerData.referee) && names[0] !== canonical(game.providerData.referee)) {
      crewIssues.push('schedule_referee_conflict'); continue;
    }
    crew.push({ role, name: names[0] });
  }
  const duplicateNames = crew.filter(entry => crew.some(other => other.role !== entry.role && other.name === entry.name)).map(entry => entry.name);
  if (duplicateNames.length) crewIssues.push('official_assigned_multiple_roles');
  const retained = crew.filter(entry => !duplicateNames.includes(entry.name));
  return { crew: retained, crewStatus: crewIssues.length ? 'conflict' : retained.length === 7 ? 'complete' : retained.length ? 'partial' : 'missing', crewIssues };
}

const extractorChecksum = await checksumFile(path.join(root, 'packages/core/src/officiating-observations.ts'));
const builderChecksum = await checksumFile(path.join(root, 'scripts/build-officiating-corpus.ts'));
for (const season of seasons) {
  const { file, source } = await publicPbpSource(root, season, arguments_.includes('--download-missing'), arguments_.includes('--refresh-current-public'));
  const { games: scheduled, source: scheduleSource } = scheduleMaps.get(season)!;
  const completed = new Map([...scheduled].filter(([, game]) => game.homeScore !== null && game.awayScore !== null && Number.isInteger(game.homeScore) && Number.isInteger(game.awayScore) && game.homeScore >= 0 && game.awayScore >= 0 && numberOrNull(game.providerData.result) === game.homeScore - game.awayScore));
  const games: CorpusGame[] = [], exclusions: { gameId: string; reason: string }[] = [];
  const seen = new Set<string>();
  let sourceRows = 0, regularSeasonRows = 0, candidatePlayRows = 0, openingKickoffVerifiedGames = 0;
  let currentId: string | null = null, current: ProviderRow[] = [];
  const finishGame = () => {
    if (!currentId) return;
    if (seen.has(currentId)) throw new Error(`Non-contiguous game in source: ${currentId}`);
    seen.add(currentId);
    const game = completed.get(currentId);
    if (!game) { exclusions.push({ gameId: currentId, reason: scheduled.has(currentId) ? 'schedule_not_final' : 'schedule_missing' }); return; }
    candidatePlayRows += current.length;
    const terminal = current[current.length - 1];
    const missingStart = String(current[0]?.desc ?? '').trim() !== 'GAME';
    let reason: string | null = null;
    if (current.some(play => play.game_id !== game.id || play.home_team !== game.homeTeam || play.away_team !== game.awayTeam || play.season !== season)) reason = 'play_identity_mismatch';
    else if (new Set(current.map(play => String(play.play_id))).size !== current.length) reason = 'duplicate_play_id';
    else if (!/^END GAME(?:\s|$)/i.test(String(terminal?.desc ?? '').trim())) reason = 'game_end_marker_missing';
    else if ((numberOrNull(terminal.qtr) ?? 0) < 4) reason = 'terminal_quarter_invalid';
    else if (terminal.drive_end_transition && terminal.drive_end_transition !== 'END_GAME') reason = 'terminal_transition_conflict';
    else if (numberOrNull(terminal.total_home_score) !== game.homeScore || numberOrNull(terminal.total_away_score) !== game.awayScore) reason = 'terminal_score_mismatch';
    else if (![1, 2, 3, 4].every(quarter => current.some(play => play.qtr === quarter))) reason = 'quarters_incomplete';
    else if (!hasVerifiedGameOpening(current)) reason = 'opening_play_missing';
    if (reason) { exclusions.push({ gameId: currentId, reason }); return; }
    if (missingStart) openingKickoffVerifiedGames++;
    games.push({ game, observation: extractOfficiatingObservation(game, current), ...crewFor(game), playCount: current.length,
      source: { playByPlayChecksum: source.checksum, scheduleChecksum: scheduleSource.checksum, officialsChecksum: officialMetadata.checksum } });
  };
  const parser = createReadStream(file).pipe(parse({ columns: (headers: string[]) => {
    if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new Error('Invalid source CSV columns');
    return headers;
  }, bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024 }));
  for await (const raw of parser) {
    sourceRows++;
    if (raw.season_type !== 'REG') continue;
    regularSeasonRows++;
    const id = String(raw.game_id ?? '');
    if (id !== currentId) { finishGame(); currentId = id; current = []; }
    current.push({ ...gameTeamNames(normalizeRow(raw), completed.get(id)), source_order: current.length });
  }
  finishGame();
  for (const gameId of completed.keys()) if (!seen.has(gameId)) exclusions.push({ gameId, reason: 'play_by_play_missing' });
  games.sort((a, b) => (a.game.kickoffAt ?? '').localeCompare(b.game.kickoffAt ?? '') || a.game.week - b.game.week || a.game.id.localeCompare(b.game.id));
  const counts = { sourceRows, regularSeasonRows, candidatePlayRows, openingKickoffVerifiedGames, includedGames: games.length, includedPlayRows: games.reduce((total, entry) => total + entry.playCount, 0),
    opportunities: games.reduce((total, entry) => total + entry.observation.opportunities.length, 0), scheduledCompletedGames: completed.size,
    exclusions: Object.fromEntries([...new Set(exclusions.map(entry => entry.reason))].map(reason => [reason, exclusions.filter(entry => entry.reason === reason).length])),
    crews: Object.fromEntries(['complete', 'partial', 'missing', 'conflict'].map(status => [status, games.filter(entry => entry.crewStatus === status).length])) };
  const artifact = { schemaVersion: 1, season, extractorChecksum, builderChecksum, aliasesChecksum: checksumBytes(Buffer.from(JSON.stringify(aliases))), teamAliases,
    license: 'CC-BY-4.0', sources: { playByPlay: stableSource(source), schedule: stableSource(scheduleSource), officials: { ...officialMetadata, bytes: officialBytes.length } },
    counts, excludedOfficialRows, exclusions, games };
  const bytes = Buffer.from(JSON.stringify(artifact) + '\n');
  const archive = `season-${season}.json.gz`;
  await writeAtomic(path.join(root, 'data/officiating-corpus', archive), gzipSync(bytes, { level: 9 }));
  await writeAtomic(path.join(root, 'data/officiating-corpus', `season-${season}.metadata.json`), JSON.stringify({ ...artifact, games: undefined, archive, checksum: checksumBytes(bytes) }, null, 2) + '\n');
  console.log(JSON.stringify({ season, archive, checksum: checksumBytes(bytes), ...counts }));
}
