import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import type { Game } from '../packages/core/src/contracts.js';
import { normalizeRow, type ProviderRow } from '../packages/core/src/normalize.js';
import { buildOvertimeStates, estimateOvertimeTimeline, overtimeOutcomeProbabilities, overtimeReferenceChecksum, OVERTIME_MODEL_VERSION, OVERTIME_PARAMETERS, type OvertimeReference, type OvertimeReferenceState, type OvertimeState } from '../packages/core/src/overtime.js';

// Fixed design declared before examining 2026 outcomes. Only 2017–2025 sources enter this artifact.
const root = process.cwd();
const snapshotArgument = process.argv.indexOf('--snapshot-root');
const snapshotRoot = snapshotArgument >= 0 ? process.argv[snapshotArgument + 1] : path.join(root, 'data/snapshots');
const cache = path.join(root, 'data/overtime-sources');
const output = path.join(root, 'analytics/models');
const sources: OvertimeReference['sources'] = [];
const rows: OvertimeReferenceState[] = [];
const gamesForEvaluation: { game: Game; plays: ProviderRow[] }[] = [];
const parserCounts: Record<string, number> = {};
await mkdir(cache, { recursive: true });
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function sourceFor(season: number): Promise<{ file: string; url: string }> {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv`;
  let indexes: string[] = [];
  try { indexes = await readdir(path.join(snapshotRoot, 'index')); } catch { /* Fresh workspace. */ }
  for (const index of indexes) {
    const data = JSON.parse(await readFile(path.join(snapshotRoot, 'index', index), 'utf8'));
    if (data.snapshot?.url !== url) continue;
    const file = path.join(snapshotRoot, 'snapshots', `${data.snapshot.checksum}.csv`);
    try { if ((await stat(file)).size > 0 && await sha256(file) === data.snapshot.checksum) return { file, url }; } catch { /* Download missing snapshot. */ }
  }
  const file = path.join(cache, `play_by_play_${season}.csv`);
  try { if ((await stat(file)).size > 0) return { file, url }; } catch { /* Download immutable local snapshot. */ }
  console.log(`Downloading public ${season} play-by-play`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Source ${season}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(file, { flags: 'wx' }));
  return { file, url };
}
function reference(): OvertimeReference {
  const payload: Omit<OvertimeReference, 'checksum'> = { schemaVersion: 1, modelVersion: OVERTIME_MODEL_VERSION, startSeason: 2017, endSeason: 2025, parameters: OVERTIME_PARAMETERS, sources, rows,
    notes: [
      'Experimental empirical regular-season overtime estimates, not calibrated probabilities or causal play effects.',
      'Only 2017–2025 ten-minute regular-season overtime; chronological inference excludes the entire target season.',
      'Future-rule compatibility requires an exact possession phase and score differential. Pre-2025 opening possessions never supply 2025+ opening estimates.',
      'At most one closest state per historical game, at least 20 distinct games, at most 40 equally weighted games; fixed clock, field and down neighborhood limits.',
      'Three-outcome probabilities use a symmetric Dirichlet(0.5,0.5,0.5) pseudocount, retain ties, and are not forced to 0 or 1.',
      'Missing states, tries, touchdown-response phases, postseason, ambiguous possession changes and special kick/turnover exceptions remain unavailable.',
      'Only preplay features determine neighbors. Final scores label historical outcomes only. Provider order is preserved; future drive annotations and provider WP are never predictors.',
      'Data attribution: nflverse/nflfastR, CC-BY-4.0 https://creativecommons.org/licenses/by/4.0/ .',
    ] };
  return { ...payload, checksum: overtimeReferenceChecksum(payload) };
}
for (let season = 2017; season <= 2025; season++) {
  const { file, url } = await sourceFor(season);
  const games = new Map<string, ProviderRow[]>();
  let count = 0;
  for await (const raw of createReadStream(file).pipe(parse({ columns: true, bom: true, max_record_size: 1024 * 1024 }))) {
    count++;
    if (Number(raw.qtr) <= 4 || raw.season_type !== 'REG') continue;
    const play = normalizeRow(raw);
    const id = String(play.game_id);
    if (!games.has(id)) games.set(id, []);
    games.get(id)!.push(play);
  }
  sources.push({ season, url, checksum: await sha256(file), license: 'CC-BY-4.0', rows: count, overtimeGames: games.size });
  for (const [id, plays] of games) {
    const first = plays[0], terminal = plays[plays.length - 1];
    if (terminal.desc !== 'END GAME' || typeof terminal.total_home_score !== 'number' || typeof terminal.total_away_score !== 'number') { parserCounts.missingTerminal = (parserCounts.missingTerminal ?? 0) + 1; continue; }
    const game: Game = { id, season, week: Number(first.week), gameType: 'REG', homeTeam: String(first.home_team), awayTeam: String(first.away_team), homeScore: terminal.total_home_score, awayScore: terminal.total_away_score, kickoffAt: null, providerData: {} };
    gamesForEvaluation.push({ game, plays });
    for (const state of buildOvertimeStates(game, plays)) {
      const key = state.reasonCode ?? state.phase;
      parserCounts[key] = (parserCounts[key] ?? 0) + 1;
      if (state.reasonCode || state.observedOutcome || !state.posteam || state.clock === null || state.down === null || state.distance === null || state.yardline === null || state.scoreDifference === null || state.ownTimeouts === null || state.opponentTimeouts === null) continue;
      const homeOutcome = game.homeScore! === game.awayScore! ? 'tie' : game.homeScore! > game.awayScore! ? 'win' : 'loss';
      const outcome = homeOutcome === 'tie' ? 'tie' : state.posteam === game.homeTeam ? homeOutcome : homeOutcome === 'win' ? 'loss' : 'win';
      rows.push({ gameId: id, season, playId: state.playId, phase: state.phase, clock: state.clock, down: state.down, distance: state.distance, yardline: state.yardline, scoreDifference: state.scoreDifference, ownTimeouts: state.ownTimeouts, opponentTimeouts: state.opponentTimeouts, outcome });
    }
  }
  console.log(JSON.stringify({ season, games: games.size, accumulatedReferenceStates: rows.length }));
}
const artifact = reference();
function phaseBaseline(game: Game, state: OvertimeState): ReturnType<typeof overtimeOutcomeProbabilities> | null {
  const distinct = new Map<string, OvertimeReferenceState>();
  for (const row of rows) if (row.season < game.season && row.phase === state.phase && row.scoreDifference === state.scoreDifference && !distinct.has(row.gameId)) distinct.set(row.gameId, row);
  return distinct.size ? overtimeOutcomeProbabilities([...distinct.values()]) : null;
}
function evaluate(year: number) {
  let eligible = 0, estimated = 0;
  const perGame: { gameId: string; estimates: number; eligible: number; modelBrier: number | null; phaseBaselineBrier: number | null }[] = [];
  const phases: Record<string, { eligible: number; estimates: number; games: Set<string> }> = {};
  for (const { game, plays } of gamesForEvaluation.filter(entry => entry.game.season === year)) {
    const states = buildOvertimeStates(game, plays);
    const points = estimateOvertimeTimeline(game, plays, artifact);
    const errors: number[] = [], baselineErrors: number[] = [];
    let gameEligible = 0;
    for (let index = 0; index < states.length; index++) {
      const state = states[index], point = points[index];
      if (state.observedOutcome || state.down === null || !state.posteam) continue;
      eligible++; gameEligible++;
      const phase = phases[state.phase] ??= { eligible: 0, estimates: 0, games: new Set<string>() };
      phase.eligible++;
      if (point.status !== 'experimental') continue;
      estimated++; phase.estimates++; phase.games.add(game.id);
      const home = game.homeScore! > game.awayScore! ? 1 : 0, away = game.awayScore! > game.homeScore! ? 1 : 0, tie = game.homeScore === game.awayScore ? 1 : 0;
      errors.push((point.homeWp! - home) ** 2 + (point.awayWp! - away) ** 2 + (point.tieProbability! - tie) ** 2);
      const baseline = phaseBaseline(game, state)!;
      const homeP = state.posteam === game.homeTeam ? baseline.win : baseline.loss;
      const awayP = state.posteam === game.homeTeam ? baseline.loss : baseline.win;
      baselineErrors.push((homeP - home) ** 2 + (awayP - away) ** 2 + (baseline.tie - tie) ** 2);
    }
    const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    perGame.push({ gameId: game.id, eligible: gameEligible, estimates: errors.length, modelBrier: average(errors), phaseBaselineBrier: average(baselineErrors) });
  }
  const modeled = perGame.filter(game => game.modelBrier !== null);
  return { year, trainingThrough: year - 1, games: perGame.length, gamesWithEstimates: modeled.length, eligibleStates: eligible, estimatedStates: estimated, coverage: eligible ? estimated / eligible : 0,
    gameWeightedThreeClassBrier: modeled.length ? modeled.reduce((sum, game) => sum + game.modelBrier!, 0) / modeled.length : null,
    gameWeightedPhaseBaselineBrier: modeled.length ? modeled.reduce((sum, game) => sum + game.phaseBaselineBrier!, 0) / modeled.length : null,
    phases: Object.fromEntries(Object.entries(phases).map(([phase, value]) => [phase, { ...value, games: value.games.size }])), perGame };
}
const evaluation = { schemaVersion: 1, modelVersion: OVERTIME_MODEL_VERSION, referenceChecksum: artifact.checksum, design: 'Fixed comparable-state empirical estimator; no parameters selected using 2026 games. Chronological evaluation, one-game-one-weight Brier on estimated states; baseline uses same test states and one earliest phase-compatible state per prior game. Brier sums squared error across win/loss/tie (range 0–2). Not calibrated or promoted.', parameters: OVERTIME_PARAMETERS, parserCounts,
  referenceGames: new Set(rows.map(row => row.gameId)).size, referenceStates: rows.length,
  phases: Object.fromEntries([...new Set(rows.map(row => row.phase))].map(phase => [phase, { games: new Set(rows.filter(row => row.phase === phase).map(row => row.gameId)).size, states: rows.filter(row => row.phase === phase).length }])),
  chronological: [evaluate(2024), evaluate(2025)], limitations: ['Only 14 regular-season overtime games in the new 2025 rules: opening-possession estimates remain below the 20-game minimum.', 'Neighbor probabilities have not been independently calibrated; game-weighted diagnostics are descriptive and have limited precision.', 'Regular-season only; postseason continuation, touchdown responses/tries and possession exceptions withheld.', 'Observed terminal results are excluded from evaluation.', 'No 2026 labels or states enter training or parameter selection.'] };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'overtime-reference.json'), JSON.stringify(artifact));
await writeFile(path.join(output, 'overtime-evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n');
console.log(JSON.stringify({ referenceGames: evaluation.referenceGames, referenceStates: rows.length, checksum: artifact.checksum, evaluation: evaluation.chronological.map(({ perGame, ...rest }) => rest) }));
