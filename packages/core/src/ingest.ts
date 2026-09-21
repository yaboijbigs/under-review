import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Game, SourceSnapshot } from './contracts.js';
import { AnalyticsEngineError, runRRequest, type AnalyticsOptions } from './analytics-bridge.js';
import { assertGameId, joinCharting, normalizePlays, normalizeSchedule, parseCsv, validateGameData, type ChartingCoverage, type GameValidation, type ProviderRow } from './normalize.js';
import { SourceError, SOURCE_LICENSES, sourceUrls, type SnapshotStore } from './sources.js';

export { LocalSnapshotStore } from './sources.js';
export interface IngestionResult {
  game: Game;
  plays: ProviderRow[];
  ftn: ProviderRow[];
  snapshots: SourceSnapshot[];
  validation: GameValidation;
  sourceKind: 'raw' | 'clean';
  chartingCoverage: ChartingCoverage;
  warnings: string[];
}

export async function syncSchedule(season: number, store: SnapshotStore): Promise<{ games: Game[]; snapshots: SourceSnapshot[] }> {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) throw new SourceError('invalid_season', 'Season must be an NFL season from 1999 onwards.');
  const snapshot = await store.fetch({ provider: 'nflverse-schedules', url: sourceUrls.schedules, license: SOURCE_LICENSES.nflverse, extension: 'csv', metadata: { attribution: 'Lee Sharpe and nflverse', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } });
  const rows = parseCsv(await store.read(snapshot));
  if (!rows.length || !('game_id' in rows[0]) || !('game_type' in rows[0]) || !('season' in rows[0])) throw new SourceError('schedule_schema_invalid', 'Schedule CSV lacks required identity fields.');
  const games = rows.filter((row) => row.season === season && ['REG', 'WC', 'DIV', 'CON', 'SB'].includes(String(row.game_type))).map(normalizeSchedule);
  const ids = new Set<string>();
  for (const game of games) {
    if (ids.has(game.id)) throw new SourceError('schedule_duplicate_game', 'Schedule contains duplicate game identifiers.');
    ids.add(game.id);
  }
  return { games, snapshots: [snapshot] };
}

export async function buildRawGame(game: Game, store: SnapshotStore, snapshot: SourceSnapshot, options?: AnalyticsOptions): Promise<ProviderRow[]> {
  assertGameId(game.id);
  const directory = await mkdtemp(path.join(tmpdir(), 'under-review-raw-'));
  try {
    const seasonDirectory = path.join(directory, String(game.season));
    await mkdir(seasonDirectory, { recursive: true });
    await writeFile(path.join(seasonDirectory, `${game.id}.rds`), await store.read(snapshot), { mode: 0o600 });
    const output = await runRRequest({ schemaVersion: 1, action: 'build_pbp', gameId: game.id, rawDirectory: directory }, options);
    if (!Array.isArray(output.plays) || !output.plays.every((play) => play && typeof play === 'object' && !Array.isArray(play))) throw new AnalyticsEngineError('raw_build_contract_invalid', 'R raw-PBP builder returned invalid plays.');
    return normalizePlays(output.plays as ProviderRow[], game.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function ingestGame(game: Game, store: SnapshotStore, options: {
  preferRaw?: boolean;
  analytics?: AnalyticsOptions;
  buildRaw?: (game: Game, store: SnapshotStore, snapshot: SourceSnapshot) => Promise<ProviderRow[]>;
} = {}): Promise<IngestionResult> {
  assertGameId(game.id);
  const snapshots: SourceSnapshot[] = [];
  const warnings: string[] = [];
  let plays: ProviderRow[] = [];
  let sourceKind: 'raw' | 'clean' = 'clean';
  if (options.preferRaw !== false) {
    try {
      const raw = await store.fetch({ provider: 'nflverse-raw-pbp', url: sourceUrls.raw(game.id), license: SOURCE_LICENSES.nflverse, extension: 'rds', metadata: { gameId: game.id, attribution: 'nflverse / nflfastR', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } });
      const built = await (options.buildRaw ?? ((g, s, r) => buildRawGame(g, s, r, options.analytics)))(game, store, raw);
      // A stale or partial raw snapshot is not sufficient just because the builder succeeded.
      const rawValidation = validateGameData(game, built);
      if (!rawValidation.valid) throw new SourceError('raw_pbp_incomplete', `Raw data is not publishable: ${rawValidation.issues.join(', ')}.`, true);
      plays = built;
      snapshots.push(raw);
      sourceKind = 'raw';
    } catch (error) {
      if (!(error instanceof SourceError) && !(error instanceof AnalyticsEngineError)) throw error;
      warnings.push(`Raw play-by-play unavailable (${error.code}); attempting clean-season data.`);
    }
  }
  if (!plays.length) {
    const clean = await store.fetch({ provider: 'nflverse-pbp', url: sourceUrls.clean(game.season), license: SOURCE_LICENSES.nflverse, extension: 'csv', metadata: { season: game.season, attribution: 'nflverse / nflfastR', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } });
    snapshots.push(clean);
    const rows = parseCsv(await store.read(clean));
    if (!rows.length || !('game_id' in rows[0]) || !('play_id' in rows[0])) throw new SourceError('pbp_schema_invalid', 'Play-by-play CSV lacks game/play identifiers.');
    plays = normalizePlays(rows, game.id);
  }

  let charting: ProviderRow[] = [];
  if (game.season >= 2022) {
    try {
      const snapshot = await store.fetch({ provider: 'ftn-via-nflverse', url: sourceUrls.ftn(game.season), license: SOURCE_LICENSES.ftn, extension: 'csv', metadata: { season: game.season, attribution: 'FTN Data via nflverse', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', shareAlike: true } }, { maxAgeMs: 6 * 60 * 60 * 1000 });
      const rows = parseCsv(await store.read(snapshot));
      if (rows.length && (!('nflverse_game_id' in rows[0]) || !('nflverse_play_id' in rows[0]))) throw new SourceError('ftn_schema_invalid', 'FTN CSV lacks documented join identifiers.');
      charting = rows;
      snapshots.push(snapshot);
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      warnings.push(`Charting unavailable (${error.code}); missing charting is not zero errors.`);
    }
  } else warnings.push('Charting unavailable: FTN historical coverage starts in 2022.');
  const joined = joinCharting(game.id, plays, charting);
  warnings.push(...joined.issues);
  return { game, plays, ftn: joined.rows, snapshots, validation: validateGameData(game, plays), sourceKind, chartingCoverage: joined.coverage, warnings };
}
