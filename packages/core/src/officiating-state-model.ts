import { createHash } from 'node:crypto';
import type { OfficiatingGameObservation, OfficiatingState } from './officiating-observations.js';

/** A descriptive state-value baseline, not a model of whether an official was correct. */
export const OFFICIATING_STATE_MODEL_VERSION = 'under-review-officiating-state-v1';
export const STATE_MODEL_PARAMETERS = {
  previousSeasons: 5, ridge: .001, maxIterations: 2000, tolerance: 1e-8,
  minTrainingGames: 100, minTrainingObservations: 5000,
  minLocalGames: 20, minLocalObservations: 80,
  fieldSupportRadius: 20,
} as const;

const EP_NAMES = ['intercept', 'down2', 'down3', 'down4',
  'distance1_5', 'distance5_10', 'distance10_20', 'distance20_100',
  'field0_20', 'field20_40', 'field40_60', 'field60_80', 'field80_100',
  'halfClock', 'halfClockLog',
  'clockField0_20', 'clockField20_40', 'clockField40_60', 'clockField60_80', 'clockField80_100',
  'clockDistance1_5', 'clockDistance5_10', 'clockDistance10_20', 'clockDistance20_100'];
const WP_NAMES = [...EP_NAMES, 'score', 'scoreClock', 'possessionHome', 'gameClock', 'timeoutDifference', 'secondHalfReceive'];
const WP_BASELINE_NAMES = ['intercept', 'score', 'scoreClock', 'possessionHome', 'gameClock'];
const SIGNS_EP = EP_NAMES.map(n => /^(?:clockD|d)istance/.test(n) ? -1 : /^(?:clockF|f)ield/.test(n) ? 1 : 0);
const SIGNS_WP = [...SIGNS_EP, 1, 1, 0, 0, 0, 0];
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const count = (x: unknown): x is number => finite(x) && Number.isInteger(x) && x >= 0;
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ramp = (x: number, start: number, width: number): number => clamp((x - start) / width, 0, 1);
const dot = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + x * b[i], 0);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only objects recursively frozen by this module enter this cache. A caller's shallow freeze is insufficient.
const verifiedFrozenModels = new WeakSet<object>();
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export interface StateModelSupportCell {
  down: number; distanceBand: number; clockBand: number; fieldBand: number;
  observations: number; games: number; wpObservations: number; wpGames: number;
}
export interface StateModelFit {
  featureNames: string[]; coefficients: number[] | null; observations: number; games: number;
  iterations: number; converged: boolean;
}
export interface OfficiatingStateModel {
  schemaVersion: 1; version: string; targetSeason: number; trainingSeasons: number[];
  parameters: typeof STATE_MODEL_PARAMETERS;
  ep: StateModelFit; wp: StateModelFit; support: StateModelSupportCell[];
  baselines: { epMean: number | null; homeWinMean: number | null; scoreClockWp: StateModelFit };
  coverage: { suppliedGames: number; trainingGames: number; conflictingGames: number; invalidStates: number; missingEpLabels: number; missingWpLabels: number };
  notes: string[]; checksum: string;
}
export interface StateEstimate {
  status: 'experimental' | 'unavailable'; reasonCode: string | null;
  ep: number | null; homeWp: number | null; awayWp: number | null; wpReasonCode: string | null;
  support: { observations: number; games: number; wpObservations: number; wpGames: number; gamesAreLowerBound: true };
  modelVersion: string;
}

/** Numeric clocks must describe the same nonterminal regulation instant. No terminal scores are inferred. */
export function stateModelInputReason(s: OfficiatingState): string | null {
  if (!object(s)) return 'missing_state';
  if (finite(s.quarter) && s.quarter > 4) return 'unsupported_overtime';
  if (typeof s.possessionTeam !== 'string' || !s.possessionTeam || typeof s.defenseTeam !== 'string' || !s.defenseTeam || s.possessionTeam === s.defenseTeam) return 'invalid_state_teams';
  if (!Number.isInteger(s.quarter) || s.quarter < 1 || s.quarter > 4 || !Number.isInteger(s.down) || s.down < 1 || s.down > 4) return 'invalid_state_period_or_down';
  if (![s.yardsToGo, s.yardline100, s.halfSecondsRemaining, s.gameSecondsRemaining, s.scoreDifference, s.possessionTimeouts, s.defenseTimeouts, s.receivesSecondHalfKickoff].every(finite)) return 'missing_or_invalid_state_fields';
  if (s.halfSecondsRemaining! <= 0 || s.gameSecondsRemaining! <= 0) return 'terminal_or_halftime';
  if (s.yardline100! <= 0 || s.yardline100! >= 100 || s.yardsToGo! <= 0 || s.yardsToGo! > 99 || s.yardsToGo! > s.yardline100! + .01) return 'unsupported_state_geometry';
  if (s.halfSecondsRemaining! > 1800 || s.gameSecondsRemaining! > 3600 ||
      Math.abs(s.gameSecondsRemaining! - s.halfSecondsRemaining! - (s.quarter <= 2 ? 1800 : 0)) > 1 ||
      ((s.quarter === 1 || s.quarter === 3) ? s.halfSecondsRemaining! < 900 : s.halfSecondsRemaining! > 900)) return 'inconsistent_state_clocks';
  if (Math.abs(s.scoreDifference!) > 100 || ![s.possessionTimeouts, s.defenseTimeouts].every(x => Number.isInteger(x) && x! >= 0 && x! <= 3) || ![0, 1].includes(s.receivesSecondHalfKickoff!)) return 'unsupported_state_context';
  return null;
}

function epFeatures(s: OfficiatingState): number[] {
  const clock = s.halfSecondsRemaining! / 1800, advance = 100 - s.yardline100!;
  const distance = [ramp(s.yardsToGo!, 1, 4), ramp(s.yardsToGo!, 5, 5), ramp(s.yardsToGo!, 10, 10), ramp(s.yardsToGo!, 20, 80)];
  const field = [0, 20, 40, 60, 80].map(start => ramp(advance, start, 20));
  return [1, Number(s.down === 2), Number(s.down === 3), Number(s.down === 4), ...distance, ...field,
    clock, Math.log1p(s.halfSecondsRemaining!) / Math.log(1801), ...field.map(x => x * clock), ...distance.map(x => x * clock)];
}
function wpContext(s: OfficiatingState, homeTeam: string): number[] {
  return [s.scoreDifference! / 28, s.scoreDifference! / Math.sqrt(s.gameSecondsRemaining! + 30), Number(s.possessionTeam === homeTeam), s.gameSecondsRemaining! / 3600];
}
function wpFeatures(s: OfficiatingState, homeTeam: string): number[] {
  return [...epFeatures(s), ...wpContext(s, homeTeam), (s.possessionTimeouts! - s.defenseTimeouts!) / 3, s.receivesSecondHalfKickoff!];
}
const distanceBand = (n: number): number => n <= 3 ? 0 : n <= 7 ? 1 : n <= 10 ? 2 : n <= 20 ? 3 : 4;
const clockBand = (n: number): number => n <= 60 ? 0 : n <= 120 ? 1 : n <= 300 ? 2 : n <= 900 ? 3 : 4;
const cellFor = (s: OfficiatingState) => ({ down: s.down, distanceBand: distanceBand(s.yardsToGo!), clockBand: clockBand(s.halfSecondsRemaining!), fieldBand: Math.floor(s.yardline100! / 10) });

/** Sufficient statistics avoid storing training plays in the fitted artifact. */
class RidgeFit {
  readonly gram: number[][];
  readonly rhs: number[];
  readonly games = new Set<string>();
  observations = 0; total = 0;
  constructor(readonly names: string[], readonly signs: number[]) {
    this.gram = names.map(() => names.map(() => 0)); this.rhs = names.map(() => 0);
  }
  add(x: number[], y: number, game: string): void {
    this.observations++; this.games.add(game); this.total += y;
    for (let i = 0; i < x.length; i++) {
      this.rhs[i] += x[i] * y;
      for (let j = 0; j <= i; j++) this.gram[i][j] += x[i] * x[j];
    }
  }
  finish(): StateModelFit {
    const result: StateModelFit = { featureNames: [...this.names], coefficients: null, observations: this.observations, games: this.games.size, iterations: 0, converged: false };
    if (this.observations < STATE_MODEL_PARAMETERS.minTrainingObservations || this.games.size < STATE_MODEL_PARAMETERS.minTrainingGames) return result;
    const means = this.gram.map(row => row[0] / this.observations), meanY = this.total / this.observations;
    // Eliminate the unpenalized intercept analytically, including constant clock/context columns.
    const a = this.gram.map((row, i) => row.map((_, j) => (i >= j ? this.gram[i][j] : this.gram[j][i]) / this.observations - means[i] * means[j] + (i === j && i !== 0 ? STATE_MODEL_PARAMETERS.ridge : 0)));
    const b = this.rhs.map((x, i) => x / this.observations - means[i] * meanY), beta = this.names.map(() => 0);
    for (let iteration = 1; iteration <= STATE_MODEL_PARAMETERS.maxIterations; iteration++) {
      for (let j = 1; j < beta.length; j++) {
        const raw = (b[j] - dot(a[j], beta) + a[j][j] * beta[j]) / a[j][j];
        const next = this.signs[j] === 1 ? Math.max(0, raw) : this.signs[j] === -1 ? Math.min(0, raw) : raw;
        beta[j] = next;
      }
      result.iterations = iteration;
      const kkt = Math.max(...beta.slice(1).map((_, k) => {
        const j = k + 1, gradient = dot(a[j], beta) - b[j];
        return beta[j] === 0 && this.signs[j] === 1 ? Math.max(0, -gradient) : beta[j] === 0 && this.signs[j] === -1 ? Math.max(0, gradient) : Math.abs(gradient);
      }));
      if (kkt < STATE_MODEL_PARAMETERS.tolerance) { result.converged = true; break; }
    }
    beta[0] = meanY - dot(means, beta);
    // A fixed iteration limit is reproducible; nonconvergence is explicit and unavailable at inference.
    if (beta.every(finite)) result.coefficients = beta;
    return result;
  }
}

export function stateModelChecksum(model: Omit<OfficiatingStateModel, 'checksum'> | OfficiatingStateModel): string {
  const { checksum: _checksum, ...payload } = model as OfficiatingStateModel;
  return hash(payload);
}

/** Caller-supplied current/future/older seasons and postseason games cannot enter either fit. */
export function fitStateModel(targetSeason: number, observations: OfficiatingGameObservation[]): OfficiatingStateModel {
  if (!Number.isInteger(targetSeason) || targetSeason < 1900 || targetSeason > 2200) throw new Error('invalid_state_model_target_season');
  const ep = new RidgeFit(EP_NAMES, SIGNS_EP), wp = new RidgeFit(WP_NAMES, SIGNS_WP), baseline = new RidgeFit(WP_BASELINE_NAMES, [0, 1, 1, 0, 0]);
  const eligible = observations.filter(g => g && Number.isInteger(g.season) && g.season >= targetSeason - 5 && g.season < targetSeason && g.gameType === 'REG');
  const groups = new Map<string, OfficiatingGameObservation[]>();
  for (const game of eligible) { const list = groups.get(game.gameId) ?? []; list.push(game); groups.set(game.gameId, list); }
  const support = new Map<string, StateModelSupportCell & { epIds: Set<string>; wpIds: Set<string> }>();
  const seasons = new Set<number>(), finalResults: number[] = [];
  const coverage = { suppliedGames: observations.length, trainingGames: 0, conflictingGames: 0, invalidStates: 0, missingEpLabels: 0, missingWpLabels: 0 };
  for (const gameId of [...groups.keys()].sort()) {
    const duplicates = groups.get(gameId)!;
    // Exact repeats do not increase support. Conflicting copies of one game are all withheld.
    const canonical = (g: OfficiatingGameObservation) => JSON.stringify({ season: g.season, homeTeam: g.homeTeam, awayTeam: g.awayTeam, opportunities: [...g.opportunities].sort((a, b) => a.playId.localeCompare(b.playId)).map(p => ({ playId: p.playId, state: p.state, labels: p.labels })) });
    if (new Set(duplicates.map(canonical)).size !== 1) { coverage.conflictingGames++; continue; }
    const game = duplicates[0];
    if (!game.gameId || !game.homeTeam || !game.awayTeam || game.homeTeam === game.awayTeam) { coverage.conflictingGames++; continue; }
    const plays = new Map<string, typeof game.opportunities>();
    for (const play of game.opportunities) { const list = plays.get(play.playId) ?? []; list.push(play); plays.set(play.playId, list); }
    const homeResults = new Set(game.opportunities.map(p => p.labels.homeWin).filter(v => v === 0 || v === .5 || v === 1));
    if (homeResults.size > 1 || [...plays.values()].some(v => new Set(v.map(p => JSON.stringify({ state: p.state, labels: p.labels }))).size > 1)) { coverage.conflictingGames++; continue; }
    let used = false;
    for (const playId of [...plays.keys()].sort()) {
      const play = plays.get(playId)![0], s = play.state;
      if (!playId || stateModelInputReason(s) || ![game.homeTeam, game.awayTeam].includes(s.possessionTeam) || ![game.homeTeam, game.awayTeam].includes(s.defenseTeam)) { coverage.invalidStates++; continue; }
      const cell = cellFor(s), key = [cell.down, cell.distanceBand, cell.clockBand, cell.fieldBand].join(':');
      const counts = support.get(key) ?? { ...cell, observations: 0, games: 0, wpObservations: 0, wpGames: 0, epIds: new Set<string>(), wpIds: new Set<string>() };
      if ([-7, -3, -2, 0, 2, 3, 7].includes(play.labels.nextScore as number) && finite(play.labels.nextScore)) {
        ep.add(epFeatures(s), play.labels.nextScore, gameId); counts.observations++; counts.epIds.add(gameId); used = true;
      } else coverage.missingEpLabels++;
      if (play.labels.homeWin === 0 || play.labels.homeWin === .5 || play.labels.homeWin === 1) {
        const ownWin = s.possessionTeam === game.homeTeam ? play.labels.homeWin : 1 - play.labels.homeWin;
        wp.add(wpFeatures(s, game.homeTeam), ownWin, gameId); baseline.add([1, ...wpContext(s, game.homeTeam)], ownWin, gameId);
        counts.wpObservations++; counts.wpIds.add(gameId); used = true;
      } else coverage.missingWpLabels++;
      support.set(key, counts);
    }
    if (used) { coverage.trainingGames++; seasons.add(game.season); if (homeResults.size === 1) finalResults.push([...homeResults][0]); }
  }
  const payload: Omit<OfficiatingStateModel, 'checksum'> = {
    schemaVersion: 1, version: OFFICIATING_STATE_MODEL_VERSION, targetSeason, trainingSeasons: [...seasons].sort((a, b) => a - b), parameters: { ...STATE_MODEL_PARAMETERS },
    ep: ep.finish(), wp: wp.finish(),
    support: [...support.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => ({ down: c.down, distanceBand: c.distanceBand, clockBand: c.clockBand, fieldBand: c.fieldBand, observations: c.observations, games: c.epIds.size, wpObservations: c.wpObservations, wpGames: c.wpIds.size })),
    baselines: { epMean: ep.observations ? ep.total / ep.observations : null, homeWinMean: finalResults.length ? finalResults.reduce((a, b) => a + b, 0) / finalResults.length : null, scoreClockWp: baseline.finish() },
    coverage,
    notes: [
      'Experimental constrained additive ridge model; no provider EP/WP labels or final scores are used as preplay features.',
      'EP is signed for possession and predicts the next scoring event in the same half: touchdown=7, field goal=3, safety=2, no later score=0. Predictions are bounded to [-7,7].',
      'Field-position and distance terms are continuous and monotone at fixed down/clock; counterfactuals are state contrasts, not causal estimates of incorrect officiating.',
      'WP is a clamped ridge linear-probability baseline for final possession-team win credit; final ties count0.5. It is not a separate tie-probability model and needs heldout Brier/calibration validation.',
      'Only supplied earlier five regular seasons are eligible; missing years are disclosed. Local support uses same down/distance/clock bands within20 field yards; games is a conservative maximum-cell distinct-game lower bound, not a sum of correlated counts.',
      'Support bins affect availability only, never the continuous fitted value. No overtime, terminal scoring, or missing-state inference. Successful estimates remain experimental pending chronological external evaluation.',
    ],
  };
  const model = { ...payload, checksum: stateModelChecksum(payload) };
  if (!validStateModel(model)) throw new Error('invalid_fitted_state_model');
  freezeTree(model); verifiedFrozenModels.add(model);
  return model;
}

function validFit(value: unknown, names: string[], signs: number[]): value is StateModelFit {
  if (!object(value) || JSON.stringify(value.featureNames) !== JSON.stringify(names) || !count(value.observations) || !count(value.games) || value.games > value.observations || !count(value.iterations) || value.iterations > STATE_MODEL_PARAMETERS.maxIterations || typeof value.converged !== 'boolean') return false;
  if (value.coefficients === null) return !value.converged;
  return Array.isArray(value.coefficients) && value.coefficients.length === names.length && value.coefficients.every((x, i) => finite(x) && Math.abs(x) < 1e6 && (signs[i] === 1 ? x >= 0 : signs[i] === -1 ? x <= 0 : true)) && value.observations >= STATE_MODEL_PARAMETERS.minTrainingObservations && value.games >= STATE_MODEL_PARAMETERS.minTrainingGames;
}

/** Structural and payload checksum validation; the caller still verifies artifact file provenance. */
export function validStateModel(value: unknown): value is OfficiatingStateModel {
  if (object(value) && verifiedFrozenModels.has(value)) return true;
  if (!object(value) || value.schemaVersion !== 1 || value.version !== OFFICIATING_STATE_MODEL_VERSION || !Number.isInteger(value.targetSeason) || (value.targetSeason as number) < 1900 || (value.targetSeason as number) > 2200 || JSON.stringify(value.parameters) !== JSON.stringify(STATE_MODEL_PARAMETERS)) return false;
  if (!Array.isArray(value.trainingSeasons) || value.trainingSeasons.some((s, i, a) => !Number.isInteger(s) || s < (value.targetSeason as number) - 5 || s >= (value.targetSeason as number) || (i > 0 && a[i - 1] >= s))) return false;
  if (!validFit(value.ep, EP_NAMES, SIGNS_EP) || !validFit(value.wp, WP_NAMES, SIGNS_WP) || !object(value.baselines) || !validFit(value.baselines.scoreClockWp, WP_BASELINE_NAMES, [0, 1, 1, 0, 0])) return false;
  if (!(value.baselines.epMean === null || finite(value.baselines.epMean) && Math.abs(value.baselines.epMean) <= 7) || !(value.baselines.homeWinMean === null || finite(value.baselines.homeWinMean) && value.baselines.homeWinMean >= 0 && value.baselines.homeWinMean <= 1)) return false;
  if (!Array.isArray(value.support) || value.support.length > 1000 || value.support.some(c => !object(c) || ![c.down, c.distanceBand, c.clockBand, c.fieldBand, c.observations, c.games, c.wpObservations, c.wpGames].every(count) || (c.down as number) < 1 || (c.down as number) > 4 || (c.distanceBand as number) > 4 || (c.clockBand as number) > 4 || (c.fieldBand as number) > 9 || (c.games as number) > (c.observations as number) || (c.wpGames as number) > (c.wpObservations as number))) return false;
  const keys = value.support.map(c => [c.down, c.distanceBand, c.clockBand, c.fieldBand].join(':'));
  if (new Set(keys).size !== keys.length || !object(value.coverage) || !['suppliedGames', 'trainingGames', 'conflictingGames', 'invalidStates', 'missingEpLabels', 'missingWpLabels'].every(k => count((value.coverage as Record<string, unknown>)[k])) || !Array.isArray(value.notes) || !value.notes.every(n => typeof n === 'string')) return false;
  const coverage = value.coverage as OfficiatingStateModel['coverage'];
  const epFit = value.ep, wpFit = value.wp;
  if (coverage.trainingGames > coverage.suppliedGames || value.ep.games > coverage.trainingGames || value.wp.games > coverage.trainingGames || (coverage.trainingGames === 0) !== (value.trainingSeasons.length === 0) || value.baselines.scoreClockWp.observations !== value.wp.observations || value.baselines.scoreClockWp.games !== value.wp.games) return false;
  if (value.support.reduce((n, c) => n + c.observations, 0) !== epFit.observations || value.support.reduce((n, c) => n + c.wpObservations, 0) !== wpFit.observations || value.support.some(c => c.games > epFit.games || c.wpGames > wpFit.games)) return false;
  return typeof value.checksum === 'string' && /^[a-f0-9]{64}$/.test(value.checksum) && stateModelChecksum(value as unknown as OfficiatingStateModel) === value.checksum;
}

function localSupport(model: OfficiatingStateModel, s: OfficiatingState): StateEstimate['support'] {
  const target = cellFor(s), cells = model.support.filter(c => c.down === target.down && c.distanceBand === target.distanceBand && c.clockBand === target.clockBand && Math.abs((c.fieldBand + .5) * 10 - s.yardline100!) <= STATE_MODEL_PARAMETERS.fieldSupportRadius);
  return { observations: cells.reduce((n, c) => n + c.observations, 0), games: Math.max(0, ...cells.map(c => c.games)), wpObservations: cells.reduce((n, c) => n + c.wpObservations, 0), wpGames: Math.max(0, ...cells.map(c => c.wpGames)), gamesAreLowerBound: true };
}
const supported = (observations: number, games: number) => observations >= STATE_MODEL_PARAMETERS.minLocalObservations && games >= STATE_MODEL_PARAMETERS.minLocalGames;
const emptySupport = (): StateEstimate['support'] => ({ observations: 0, games: 0, wpObservations: 0, wpGames: 0, gamesAreLowerBound: true });

export function estimateState(model: OfficiatingStateModel, state: OfficiatingState, homeTeam: string): StateEstimate {
  const result: StateEstimate = { status: 'unavailable', reasonCode: null, ep: null, homeWp: null, awayWp: null, wpReasonCode: null, support: emptySupport(), modelVersion: OFFICIATING_STATE_MODEL_VERSION };
  // The model is compact; revalidation prevents a mutated fitted object bypassing checksum checks.
  const invalid = !validStateModel(model) ? 'invalid_state_model' : stateModelInputReason(state) ?? (![state.possessionTeam, state.defenseTeam].includes(homeTeam) ? 'invalid_home_team' : null);
  if (invalid) return { ...result, reasonCode: invalid, wpReasonCode: invalid };
  result.support = localSupport(model, state);
  result.reasonCode = model.ep.coefficients === null ? 'insufficient_ep_training' : !model.ep.converged ? 'ep_fit_not_converged' : !supported(result.support.observations, result.support.games) ? 'insufficient_local_ep_support' : null;
  if (result.reasonCode === null) { result.ep = clamp(dot(model.ep.coefficients!, epFeatures(state)), -7, 7); result.status = 'experimental'; }
  result.wpReasonCode = model.wp.coefficients === null ? 'insufficient_wp_training' : !model.wp.converged ? 'wp_fit_not_converged' : !supported(result.support.wpObservations, result.support.wpGames) ? 'insufficient_local_wp_support' : null;
  if (result.wpReasonCode === null) { const own = clamp(dot(model.wp.coefficients!, wpFeatures(state, homeTeam)), 0, 1); result.homeWp = state.possessionTeam === homeTeam ? own : 1 - own; result.awayWp = 1 - result.homeWp; }
  return result;
}

/** Evaluation-only comparators trained on exactly the same chronological rows as the main model. */
export function estimateStateBaseline(model: OfficiatingStateModel, state: OfficiatingState, homeTeam: string): { ep: number | null; homeWp: number | null; scoreClockHomeWp: number | null } {
  if (!validStateModel(model) || stateModelInputReason(state) || ![state.possessionTeam, state.defenseTeam].includes(homeTeam)) return { ep: null, homeWp: null, scoreClockHomeWp: null };
  const fit = model.baselines.scoreClockWp;
  const own = fit.coefficients && fit.converged ? clamp(dot(fit.coefficients, [1, ...wpContext(state, homeTeam)]), 0, 1) : null;
  return { ep: model.baselines.epMean, homeWp: model.baselines.homeWinMean, scoreClockHomeWp: own === null ? null : state.possessionTeam === homeTeam ? own : 1 - own };
}

/** Validate a loaded artifact once and return an owned immutable model with the safe fast path enabled. */
export function prepareStateModel(model: unknown): OfficiatingStateModel {
  if (!validStateModel(model)) throw new Error('invalid_state_model');
  const owned = freezeTree(structuredClone(model));
  verifiedFrozenModels.add(owned);
  return owned;
}

/** Validate once and own an immutable clone for a complete heldout/modeling session. */
export function prepareStateEstimator(model: OfficiatingStateModel): {
  estimate: (state: OfficiatingState, homeTeam: string) => StateEstimate;
  baseline: (state: OfficiatingState, homeTeam: string) => ReturnType<typeof estimateStateBaseline>;
} {
  const owned = prepareStateModel(model);
  return Object.freeze({ estimate: (state: OfficiatingState, homeTeam: string) => estimateState(owned, state, homeTeam), baseline: (state: OfficiatingState, homeTeam: string) => estimateStateBaseline(owned, state, homeTeam) });
}
