#!/usr/bin/env node
/** Reproduce the frozen reference offline; --refresh explicitly replaces source snapshots. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'nflverse-team-game-profile-v1';
const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
const SCHEDULE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const ALIASES = { OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', JAC: 'JAX', WSH: 'WAS' };
const CORE = ['pointsFor', 'pointsAgainst', 'totalYards', 'opponentYards', 'penalties', 'penaltyYards', 'turnoverMargin'];
const REQUIRED = ['season', 'week', 'team', 'game_id', 'opponent_team', 'passing_yards', 'rushing_yards',
  'sack_yards_lost', 'passing_interceptions', 'fumbles_lost_total', 'penalties', 'penalty_yards'];

export const canonicalTeam = (team) => ALIASES[team] ?? team;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const sum = (...values) => values.some((v) => v === null) ? null : values.reduce((a, b) => a + b, 0);
const stat = (row, field) => numberOrNull(row?.[field]);
const netYards = (row) => sum(stat(row, 'rushing_yards'), stat(row, 'passing_yards'), stat(row, 'sack_yards_lost'));
const giveaways = (row) => sum(stat(row, 'passing_interceptions'), stat(row, 'fumbles_lost_total'));
const nonOffensiveTouchdowns = (row) => {
  const recoveries = stat(row, 'fumble_recovery_tds');
  return recoveries === null || recoveries > 0 ? null : sum(stat(row, 'def_tds'), stat(row, 'special_teams_tds'));
};

export function parseCsv(bytes, required = []) {
  const rows = parse(bytes, { columns: (headers) => {
    if (new Set(headers).size !== headers.length || required.some((key) => !headers.includes(key))) {
      throw new Error('CSV is missing required columns or has duplicate columns.');
    }
    return headers;
  }, bom: true, skip_empty_lines: true });
  if (!rows.length) throw new Error('CSV has no rows.');
  return rows;
}

function kickoffAt(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^\d{2}:\d{2}$/.test(time ?? '')) return null;
  const target = Date.parse(`${day}T${time}:00Z`);
  let value = target;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(value).map(({ type, value: v }) => [type, v]));
    const delta = target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    value += delta;
    if (delta === 0) return new Date(value).toISOString();
  }
  return null;
}

/** Scores and historical display codes come from schedules; stats aliases are used only for joining. */
export function normalizeProfiles(statRows, scheduleRows, season, sourceId = null) {
  const byGame = new Map();
  for (const row of statRows) {
    if (stat(row, 'season') !== season) throw new Error(`Mixed seasons in ${season} stats.`);
    const list = byGame.get(row.game_id) ?? [];
    list.push(row);
    byGame.set(row.game_id, list);
  }
  const exclusions = [];
  const rows = [];
  const games = scheduleRows.filter((g) => Number(g.season) === season && ['REG', 'WC', 'DIV', 'CON', 'SB'].includes(g.game_type));
  const scheduledIds = new Set();
  for (const game of games) {
    if (scheduledIds.has(game.game_id)) throw new Error(`Duplicate schedule game ${game.game_id}.`);
    scheduledIds.add(game.game_id);
    const fail = (reason) => exclusions.push({ gameId: game.game_id, reason });
    if (stat(game, 'home_score') === null || stat(game, 'away_score') === null) { fail('no_final_schedule_score'); continue; }
    const pair = byGame.get(game.game_id);
    if (!pair) { fail('no_team_stats'); continue; }
    if (pair.some((r) => !r.team || !r.opponent_team)) { fail('unattributed_team_stats'); continue; }
    if (pair.length !== 2 || new Set(pair.map((r) => canonicalTeam(r.team))).size !== 2) { fail('invalid_team_pair'); continue; }
    const home = pair.find((r) => canonicalTeam(r.team) === canonicalTeam(game.home_team));
    const away = pair.find((r) => canonicalTeam(r.team) === canonicalTeam(game.away_team));
    if (!home || !away || canonicalTeam(home.opponent_team) !== canonicalTeam(away.team)
      || canonicalTeam(away.opponent_team) !== canonicalTeam(home.team)) { fail('schedule_team_mismatch'); continue; }
    for (const isHome of [false, true]) {
      const team = isHome ? home : away;
      const opponent = isHome ? away : home;
      const given = giveaways(team);
      const taken = giveaways(opponent);
      const profile = {
        gameId: game.game_id, season, week: stat(game, 'week'), gameType: game.game_type,
        date: game.gameday || null, kickoffAt: kickoffAt(game.gameday, game.gametime),
        team: isHome ? game.home_team : game.away_team,
        opponent: isHome ? game.away_team : game.home_team,
        pointsFor: stat(game, isHome ? 'home_score' : 'away_score'),
        pointsAgainst: stat(game, isHome ? 'away_score' : 'home_score'),
        totalYards: netYards(team), opponentYards: netYards(opponent),
        penalties: stat(team, 'penalties'), penaltyYards: stat(team, 'penalty_yards'),
        turnoverMargin: given === null || taken === null ? null : taken - given,
        nonOffensiveTouchdowns: nonOffensiveTouchdowns(team),
        giveaways: given, takeaways: taken, sourceId,
      };
      profile.complete = CORE.every((key) => profile[key] !== null);
      rows.push(profile);
    }
  }
  for (const gameId of byGame.keys()) if (!scheduledIds.has(gameId)) exclusions.push({ gameId, reason: 'no_matching_schedule' });
  rows.sort((a, b) => a.gameId.localeCompare(b.gameId) || a.team.localeCompare(b.team));
  const nullFields = Object.fromEntries([...CORE, 'nonOffensiveTouchdowns'].map((key) => [key, rows.filter((r) => r[key] === null).length]));
  return { rows, exclusions, coverage: { season, scheduledGames: games.length,
    scoredScheduledGames: games.filter((g) => stat(g, 'home_score') !== null && stat(g, 'away_score') !== null).length,
    sourceTeamRows: statRows.length, includedGames: rows.length / 2, teamGames: rows.length,
    completeTeamGames: rows.filter((r) => r.complete).length, nullFields } };
}

async function source(url, previous, directory, refresh) {
  if (!refresh && previous) {
    const bytes = gunzipSync(await readFile(resolve(directory, `${previous.checksum}.csv.gz`)));
    if (sha256(bytes) !== previous.checksum) throw new Error(`Frozen source checksum mismatch: ${url}`);
    return { bytes, metadata: previous };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 100).toString().includes('<!DOCTYPE')) throw new Error('Unexpected aggregate response.');
  const checksum = sha256(bytes);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${checksum}.csv.gz`), gzipSync(bytes, { level: 9 }));
  return { bytes, metadata: { id: `sha256:${checksum}`, provider: 'nflverse / nflfastR', url, checksum,
    bytes: bytes.length, retrievedAt: new Date().toISOString(), lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'), license: LICENSE, archive: `${checksum}.csv.gz` } };
}

export async function buildReference({ startSeason = 1999, endSeason = 2025, refresh = false,
  output = resolve(ROOT, 'analytics/models/game-profiles.json'),
  sourceDirectory = resolve(ROOT, 'analytics/models/game-profile-sources') } = {}) {
  if (!Number.isInteger(startSeason) || !Number.isInteger(endSeason) || startSeason < 1999 || endSeason > 2025 || endSeason < startSeason) {
    throw new Error('Reference must use an inclusive season range within 1999–2025.');
  }
  let previous;
  try { previous = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prior = new Map((previous?.sources ?? []).map((s) => [s.url, s]));
  const schedule = await source(SCHEDULE_URL, prior.get(SCHEDULE_URL), sourceDirectory, refresh);
  const schedules = parseCsv(schedule.bytes, ['game_id', 'season', 'home_team', 'away_team', 'home_score', 'away_score']);
  const sources = [schedule.metadata];
  const rows = [], seasons = [], exclusions = [];
  for (let year = startSeason; year <= endSeason; year++) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${year}.csv`;
    const downloaded = await source(url, prior.get(url), sourceDirectory, refresh);
    sources.push(downloaded.metadata);
    const result = normalizeProfiles(parseCsv(downloaded.bytes, REQUIRED), schedules, year, downloaded.metadata.id);
    rows.push(...result.rows); seasons.push(result.coverage); exclusions.push(...result.exclusions);
  }
  const payload = {
    schemaVersion: 1, version: VERSION, startSeason, endSeason,
    builtAt: !refresh && previous ? previous.builtAt : new Date().toISOString(),
    sourceUrls: sources.map((s) => s.url), sourceChecksums: Object.fromEntries(sources.map((s) => [s.url, s.checksum])),
    rows, notes: [
      'Descriptive historical team-game reference, not a trained fraud, integrity, or win-probability model.',
      'Only 1999–2025 regular-season and postseason games with paired attributed team stats and schedule scores are eligible; listed exclusions remain absent.',
      'Compare historical targets only with earlier seasons. Neither the target season nor future games belong in its comparison denominator.',
      'Total net offense is rushing_yards + passing_yards + signed sack_yards_lost. Return yards are excluded.',
      'Penalty counts/yards are provider accepted-penalty stat aggregates (stat_id 93), not a count of all flags or first-penalty PBP columns.',
      'Turnover margin is opponent (passing_interceptions + fumbles_lost_total) minus own; fumbles cover all units. Turnovers on downs are excluded.',
      'Non-offensive touchdowns combine def_tds and special_teams_tds only when fumble_recovery_tds is observed zero. Positive or missing fumble-recovery TD counts make this context null because offensive/defensive attribution and overlap are ambiguous. Missing inputs remain null, not zero.',
      'Provider aggregates can differ from a PBP-derived target; reconcile material discrepancies before comparison. Complete means required fields are present, not independently gamebook-certified.',
      'Modern provider aliases join historical schedule team codes; output preserves schedule codes and game IDs.',
      'Data: nflverse / nflfastR, schedules additionally Lee Sharpe, CC BY 4.0. Transformations: joins, field selection, net totals, margins, exclusions and compression.',
    ],
    coverage: { games: rows.length / 2, teamGames: rows.length, completeTeamGames: rows.filter((r) => r.complete).length, seasons, exclusions },
    sources, license: LICENSE, rowsChecksum: sha256(JSON.stringify(rows)),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload)}\n`);
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { refresh: args.includes('--refresh') };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--refresh') continue;
    if (!['--start', '--end', '--output', '--source-dir'].includes(key) || !args[i + 1]) throw new Error(`Unknown or incomplete option ${key}`);
    const value = args[++i];
    if (key === '--start') options.startSeason = Number(value);
    if (key === '--end') options.endSeason = Number(value);
    if (key === '--output') options.output = resolve(value);
    if (key === '--source-dir') options.sourceDirectory = resolve(value);
  }
  const result = await buildReference(options);
  console.log(JSON.stringify({ version: result.version, startSeason: result.startSeason, endSeason: result.endSeason,
    games: result.coverage.games, teamGames: result.rows.length, exclusions: result.coverage.exclusions, rowsChecksum: result.rowsChecksum }));
}
