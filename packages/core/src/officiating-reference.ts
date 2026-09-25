import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Game } from './contracts.js';
import { normalizeRow, numberOrNull, type ProviderRow } from './normalize.js';
import { calibrateImpact, type CalibrationGame } from './officiating-calibration.js';
import { OFFICIATING_REFERENCE_VERSION, impactCoverageReason, officiatingResultSchema, validOfficiatingAudit, type OfficiatingAudit } from './officiating-contracts.js';
import { FREQUENCY_VERSION, type FrequencyModel } from './officiating-frequency.js';
import { calculateGameImpact, type ImpactModel } from './officiating-impact.js';
import { extractOfficiatingObservation, hasVerifiedGameOpening, type OfficiatingGameObservation } from './officiating-observations.js';
import { prepareStateModel, validStateModel, type OfficiatingStateModel } from './officiating-state-model.js';

export const OFFICIATING_REFERENCE_PARAMETERS = { prior: 1000, crewAdjustment: false } as const;
export const OFFICIATING_TEAM_ALIASES: Readonly<Record<string, string>> = Object.freeze({ OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', JAC: 'JAX', WSH: 'WAS' });
export const OFFICIATING_CREW_ROLES = ['Referee', 'Umpire', 'Down Judge', 'Line Judge', 'Field Judge', 'Side Judge', 'Back Judge'] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(2048).refine(s => s.trim() === s);
const number = z.number().finite(), count = number.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const gameId = z.string().regex(/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/);
const checksums = z.record(id, hash);
const role = z.enum(OFFICIATING_CREW_ROLES), team = z.string().regex(/^[A-Z]{2,3}$/);
const headNames = ['offensive_hold:o', 'defensive_pass:d', 'offensive_presnap:o', 'defensive_presnap:d', 'personal_foul:o', 'personal_foul:d', 'other_offense:o', 'other_defense:d'];
const counts = z.tuple([count, count]), residual = z.tuple([count, count, number.nonnegative()]);
const frequencySchema = z.object({
  version: z.literal(FREQUENCY_VERSION), targetSeason: count, trainingSeasons: z.array(count), games: count, prior: z.literal(1000),
  base: z.record(id, counts), coarse: z.record(id, counts), context: z.record(id, counts),
  teams: z.record(id, residual), opponents: z.record(id, residual),
  crew: z.record(id, z.object({ games: count, opportunities: count, actual: count, expected: number.nonnegative(), homeBenefitResidual: number }).strict()),
}).strict();
const cost = z.tuple([count, count, number.nonnegative(), number.nonnegative()]);
const impactSchema = z.object({ targetSeason: count, stateModelChecksum: hash, heads: z.record(id, cost), contexts: z.record(id, cost) }).strict();
const calibrationSchema = z.object({ gameId, season: count, maximum: number.nonnegative(), gameStatistic: number.nonnegative() }).strict();
const assignmentSchema = z.object({ status: z.enum(['complete', 'partial', 'missing', 'conflict']), roles: z.array(z.object({ role, name: id }).strict()).max(7) }).strict();
export type OfficiatingCrewAssignment = z.infer<typeof assignmentSchema>;
export interface OfficiatingSeasonReference {
  frequency: FrequencyModel;
  state: OfficiatingStateModel;
  impact: ImpactModel;
  modelChecksums: { frequency: string; state: string; impact: string };
  calibration: CalibrationGame[];
  crewAssignments: Record<string, OfficiatingCrewAssignment>;
  sourceChecksums: Record<string, string>;
}
export interface OfficiatingReference {
  schemaVersion: 1;
  version: typeof OFFICIATING_REFERENCE_VERSION;
  license: 'CC-BY-4.0';
  attribution: string;
  parameters: typeof OFFICIATING_REFERENCE_PARAMETERS;
  teamAliases: Record<string, string>;
  seasons: Record<string, OfficiatingSeasonReference>;
  provenance: { corpusChecksums: Record<string, string>; sourceChecksums: Record<string, string>; inputCodeChecksums: Record<string, string>; evaluationChecksum: string };
  checksum: string;
}
export interface LoadedOfficiatingReference { reference: OfficiatingReference; checksum: string }
const referenceSchema = z.object({
  schemaVersion: z.literal(1), version: z.literal(OFFICIATING_REFERENCE_VERSION),
  license: z.literal('CC-BY-4.0'), attribution: id,
  parameters: z.object({ prior: z.literal(1000), crewAdjustment: z.literal(false) }).strict(),
  teamAliases: z.record(team, team),
  seasons: z.record(z.enum(['2023', '2024', '2025', '2026']), z.object({
    frequency: frequencySchema, state: z.unknown(), impact: impactSchema,
    modelChecksums: z.object({ frequency: hash, state: hash, impact: hash }).strict(),
    calibration: z.array(calibrationSchema), crewAssignments: z.record(gameId, assignmentSchema), sourceChecksums: checksums,
  }).strict()),
  provenance: z.object({ corpusChecksums: checksums, sourceChecksums: checksums, inputCodeChecksums: checksums, evaluationChecksum: hash }).strict(),
  checksum: hash,
}).strict();

export function officiatingObjectChecksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function officiatingReferenceChecksum(value: Omit<OfficiatingReference, 'checksum'> | OfficiatingReference): string {
  const { checksum: _checksum, ...payload } = value as OfficiatingReference;
  return officiatingObjectChecksum(payload);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const priorYears = (year: number, n: number): number[] => Array.from({ length: n }, (_, index) => year - n + index);
export function officiatingSourceKeys(year: number): string[] {
  const base = 'https://github.com/nflverse/nflverse-data/releases/download';
  return [`${year}:playByPlay:${base}/pbp/play_by_play_${year}.csv`, `${year}:schedule:${base}/schedules/games.csv`, `${year}:officials:${base}/officials/officials.csv`];
}
const prefix = (key: string): string => key.split('|')[0];
function validFrequency(model: FrequencyModel, year: number): boolean {
  if (model.targetSeason !== year || model.games < 250 || !same(model.trainingSeasons, priorYears(year, 5))) return false;
  if (!same(Object.keys(model.base).sort(), [...headNames].sort())) return false;
  for (const map of [model.base, model.coarse, model.context]) for (const [key, values] of Object.entries(map)) {
    if (!headNames.includes(prefix(key)) || values[1] > values[0]) return false;
  }
  for (const map of [model.teams, model.opponents]) for (const [key, values] of Object.entries(map)) {
    if (!headNames.includes(prefix(key)) || values[1] > values[0] || values[2] > values[0] + 1e-6) return false;
  }
  for (const [key, value] of Object.entries(model.crew)) {
    const separator = key.indexOf('|');
    if (separator < 0 || !(OFFICIATING_CREW_ROLES as readonly string[]).includes(key.slice(0, separator)) || !key.slice(separator + 1).trim() || value.games > model.games || value.actual > value.opportunities || value.expected > value.opportunities + 1e-6 || Math.abs(value.homeBenefitResidual) > value.actual + value.expected + 1e-6) return false;
  }
  return true;
}
function validImpact(model: ImpactModel, states: OfficiatingStateModel, year: number): boolean {
  if (model.targetSeason !== year || model.stateModelChecksum !== states.checksum) return false;
  for (const map of [model.heads, model.contexts]) for (const [key, value] of Object.entries(map)) {
    if (!headNames.includes(prefix(key)) || value[1] > value[0] || value[2] > 14 * value[1] + 1e-6 || value[3] > 196 * value[1] + 1e-6 || value[2] ** 2 > value[1] * value[3] + 1e-6 * Math.max(1, value[2] ** 2)) return false;
  }
  return true;
}
function validAssignment(assignment: OfficiatingCrewAssignment): boolean {
  const roles = assignment.roles;
  if (new Set(roles.map(member => member.role)).size !== roles.length || new Set(roles.map(member => member.name)).size !== roles.length) return false;
  if (assignment.status === 'complete') return roles.length === 7;
  if (assignment.status === 'partial') return roles.length > 0 && roles.length < 7;
  if (assignment.status === 'missing') return roles.length === 0;
  return true;
}

export function validOfficiatingModels(value: unknown, year: number): value is Pick<OfficiatingSeasonReference, 'frequency' | 'state' | 'impact'> {
  const schema = z.object({ frequency: frequencySchema, state: z.unknown(), impact: impactSchema }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) return false;
  const models = value as Pick<OfficiatingSeasonReference, 'frequency' | 'state' | 'impact'>;
  return validStateModel(models.state) && models.state.targetSeason === year && same(models.state.trainingSeasons, priorYears(year, 5)) && validFrequency(models.frequency, year) && validImpact(models.impact, models.state, year);
}

/** The offline builder prevalidates models, then checks saved predictions against the exact recorded observations. */
export function verifyOfficiatingPrediction(observation: OfficiatingGameObservation, models: Pick<OfficiatingSeasonReference, 'frequency' | 'state' | 'impact'>, saved: unknown): NonNullable<OfficiatingAudit['result']> {
  const expected = officiatingResultSchema.parse(saved);
  const reproduced = officiatingResultSchema.parse(calculateGameImpact(observation, models.frequency, models.state, models.impact, 'context', []));
  if (officiatingObjectChecksum(reproduced) !== officiatingObjectChecksum(expected)) throw new Error(`Saved evaluation prediction does not reproduce: ${observation.gameId}`);
  return reproduced;
}

/** Shape, cutoff, model integrity, calibration chronology, and source provenance. */
export function validOfficiatingReference(value: unknown): value is OfficiatingReference {
  const parsed = referenceSchema.safeParse(value);
  if (!parsed.success) return false;
  const reference = value as OfficiatingReference;
  if (!same(reference.teamAliases, OFFICIATING_TEAM_ALIASES) || officiatingReferenceChecksum(reference) !== reference.checksum) return false;
  const years = Array.from({ length: 12 }, (_, index) => String(2015 + index));
  if (!same(Object.keys(reference.provenance.corpusChecksums).sort(), years)) return false;
  if (!same(Object.keys(reference.provenance.sourceChecksums).sort(), years.flatMap(year => officiatingSourceKeys(Number(year))).sort()) || !Object.keys(reference.provenance.inputCodeChecksums).length) return false;
  for (const name of ['officiating-observations', 'officiating-frequency', 'officiating-state-model', 'officiating-impact', 'officiating-calibration', 'officiating-contracts']) if (!reference.provenance.inputCodeChecksums[name]) return false;
  for (const [key, entry] of Object.entries(reference.seasons)) {
    const year = Number(key);
    if (!validOfficiatingModels({ frequency: entry.frequency, state: entry.state, impact: entry.impact }, year)) return false;
    if (entry.modelChecksums.state !== entry.state.checksum || entry.modelChecksums.frequency !== officiatingObjectChecksum(entry.frequency) || entry.modelChecksums.impact !== officiatingObjectChecksum(entry.impact)) return false;
    const ids = new Set<string>();
    for (const game of entry.calibration) {
      if (!priorYears(year, 3).includes(game.season) || !game.gameId.startsWith(`${game.season}_`) || ids.has(game.gameId) || game.maximum < game.gameStatistic) return false;
      ids.add(game.gameId);
    }
    for (const [id, assignment] of Object.entries(entry.crewAssignments)) if (!id.startsWith(`${year}_`) || !validAssignment(assignment)) return false;
    const sourceKeys = years.map(Number).filter(sourceYear => sourceYear >= year - 8 && sourceYear <= year).flatMap(officiatingSourceKeys).sort();
    if (!same(Object.keys(entry.sourceChecksums).sort(), sourceKeys) || Object.entries(entry.sourceChecksums).some(([id, checksum]) => reference.provenance.sourceChecksums[id] !== checksum)) return false;
  }
  return true;
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
const verifiedLoaded = new WeakSet<object>(), cache = new Map<string, LoadedOfficiatingReference>();
export async function loadOfficiatingReference(file = fileURLToPath(new URL('../reference/officiating-reference.json', import.meta.url))): Promise<LoadedOfficiatingReference> {
  const bytes = await readFile(file), checksum = createHash('sha256').update(bytes).digest('hex');
  const cached = cache.get(checksum);
  if (cached) return cached;
  const reference: unknown = JSON.parse(bytes.toString('utf8'));
  if (!validOfficiatingReference(reference)) throw new Error('Invalid officiating reference: schema, checksum, cutoff, or calibration integrity.');
  for (const entry of Object.values(reference.seasons)) entry.state = prepareStateModel(entry.state);
  const loaded = freezeTree({ reference, checksum });
  verifiedLoaded.add(loaded); cache.set(checksum, loaded);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return loaded;
}

/** Keep historical game identity while matching nflverse's modern franchise codes. */
export function normalizeOfficiatingRows(game: Game, rows: ProviderRow[]): ProviderRow[] {
  const canonical = (team: string): string => OFFICIATING_TEAM_ALIASES[team] ?? team;
  return rows.map((row, index) => Object.fromEntries(Object.entries({ ...normalizeRow(row), source_order: row.source_order ?? index }).map(([key, value]) => {
    if (typeof value !== 'string' || !/(?:_team$|^posteam$|^defteam$)/.test(key)) return [key, value];
    if (canonical(value) === canonical(game.homeTeam)) return [key, game.homeTeam];
    if (canonical(value) === canonical(game.awayTeam)) return [key, game.awayTeam];
    return [key, value];
  })));
}
function completeGame(game: Game, rows: ProviderRow[]): boolean {
  if (game.gameType !== 'REG' || !gameId.safeParse(game.id).success || game.id !== `${game.season}_${String(game.week).padStart(2, '0')}_${game.awayTeam}_${game.homeTeam}` || game.homeTeam === game.awayTeam || !Number.isInteger(game.homeScore) || !Number.isInteger(game.awayScore) || game.homeScore! < 0 || game.awayScore! < 0 || numberOrNull(game.providerData.result) !== game.homeScore! - game.awayScore!) return false;
  if (!rows.length || rows.some(row => row.game_id !== game.id || row.home_team !== game.homeTeam || row.away_team !== game.awayTeam || row.season !== game.season) || !hasVerifiedGameOpening(rows)) return false;
  const terminal = rows[rows.length - 1];
  return /^END GAME(?:\s|$)/i.test(String(terminal.desc ?? '').trim()) && (numberOrNull(terminal.qtr) ?? 0) >= 4 && (!terminal.drive_end_transition || terminal.drive_end_transition === 'END_GAME') && numberOrNull(terminal.total_home_score) === game.homeScore && numberOrNull(terminal.total_away_score) === game.awayScore && [1, 2, 3, 4].every(q => rows.some(row => row.qtr === q));
}
export function buildOfficiatingAudit(game: Game, rawplays: ProviderRow[], loaded: LoadedOfficiatingReference): OfficiatingAudit {
  const trusted = !!loaded && verifiedLoaded.has(loaded), entry = trusted ? loaded.reference.seasons[String(game.season)] : undefined;
  const assignment = entry?.crewAssignments[game.id] ?? { status: 'missing' as const, roles: [] };
  const audit: OfficiatingAudit = {
    version: 'under-review-officiating-v1', gameId: game.id, homeTeam: game.homeTeam, awayTeam: game.awayTeam, season: game.season,
    status: 'unavailable', reasonCode: !trusted ? 'invalid_officiating_reference' : !entry ? 'officiating_season_unavailable' : 'incomplete_final_game_data', scope: 'supported_regulation_penalty_enforcement', result: null,
    calibration: { seasons: priorYears(game.season, 3), games: 0, atLeastAsUnusual: 0, gameAtLeastAsUnusual: null, tailProbability: null, gameTailProbability: null },
    reference: { version: OFFICIATING_REFERENCE_VERSION, checksum: trusted ? loaded.checksum : '0'.repeat(64), trainingSeasons: entry?.frequency.trainingSeasons ?? [], sourceChecksums: entry?.sourceChecksums ?? (trusted ? loaded.reference.provenance.sourceChecksums : {}) },
    crew: { status: assignment.status, adjustmentApplied: false, roles: assignment.roles.map(member => {
      const stats = entry?.frequency.crew[`${member.role}|${member.name}`], games = stats?.games ?? 0;
      return { ...member, games, actualCallsPerGame: games ? stats!.actual / games : null, expectedCallsPerGame: games ? stats!.expected / games : null, homeBenefitResidualPerGame: games ? stats!.homeBenefitResidual / games : null };
    }) },
    notes: ['Only supported regulation penalty enforcement is scored; unrecorded fouls and unsupported alternatives are not inferred.', 'Crew statistics describe games assigned to each official and do not alter this fit.'],
  };
  if (!trusted || !entry) return audit;
  const rows = normalizeOfficiatingRows(game, rawplays);
  if (!completeGame(game, rows)) return audit;
  try {
    const observation = extractOfficiatingObservation(game, rows);
    const result = officiatingResultSchema.parse(calculateGameImpact(observation, entry.frequency, entry.state, entry.impact, 'context', []));
    const calibration = calibrateImpact(result, entry.calibration), reason = impactCoverageReason(result) ?? (calibration.tailProbability === null ? 'insufficient_chronological_calibration' : null);
    const built: OfficiatingAudit = { ...audit, result, calibration, status: reason ? 'limited' : 'supported', reasonCode: reason };
    if (reason || validOfficiatingAudit(built)) return built;
    return { ...audit, reasonCode: 'invalid_officiating_calculation' };
  } catch {
    return { ...audit, reasonCode: 'officiating_calculation_failed' };
  }
}
