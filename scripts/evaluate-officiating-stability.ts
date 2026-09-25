import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationGame, calibrateImpact, type CalibrationGame } from '../packages/core/src/officiating-calibration.js';
import { impactCoverageReason, officiatingTier } from '../packages/core/src/officiating-contracts.js';
import type { GameImpactResult, ImpactComparison } from '../packages/core/src/officiating-impact.js';

export interface PairedGameLoss { gameId: string; observations: number; modelLoss: number; baselineLoss: number }
export interface BootstrapComparison {
  status: 'available' | 'unavailable'; reason: string | null; games: number; observations: number;
  modelMean: number | null; baselineMean: number | null; delta: number | null;
  improvementPercent: number | null; delta95: [number, number] | null; seed: number; replicates: number;
}
function randomGenerator(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const quantile = (values: number[], p: number): number => {
  const position = (values.length - 1) * p, lower = Math.floor(position), upper = Math.ceil(position);
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
};
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Paired clusters are whole games; the estimand remains pooled per-opportunity loss, not mean game loss. */
export function pairedGameBootstrap(input: PairedGameLoss[], seed = 20260923, replicates = 5000): BootstrapComparison {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(replicates) || replicates < 100 || replicates > 100000) throw new Error('Invalid bootstrap seed or replicate count.');
  const ids = new Set<string>();
  for (const row of input) {
    if (!row.gameId || ids.has(row.gameId) || !Number.isSafeInteger(row.observations) || row.observations < 0 || !nonnegative(row.modelLoss) || !nonnegative(row.baselineLoss) || row.observations === 0 && (row.modelLoss !== 0 || row.baselineLoss !== 0)) throw new Error('Invalid or duplicate paired game losses.');
    ids.add(row.gameId);
  }
  const rows = input.filter(r => r.observations > 0).sort((a, b) => a.gameId.localeCompare(b.gameId));
  const observations = rows.reduce((n, r) => n + r.observations, 0);
  if (rows.length < 2) return { status: 'unavailable', reason: 'fewer_than_two_paired_games', games: rows.length, observations, modelMean: null, baselineMean: null, delta: null, improvementPercent: null, delta95: null, seed, replicates };
  const modelMean = rows.reduce((n, r) => n + r.modelLoss, 0) / observations, baselineMean = rows.reduce((n, r) => n + r.baselineLoss, 0) / observations;
  const random = randomGenerator(seed), deltas: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate++) {
    let n = 0, difference = 0;
    for (let i = 0; i < rows.length; i++) { const row = rows[Math.floor(random() * rows.length)]; n += row.observations; difference += row.modelLoss - row.baselineLoss; }
    deltas.push(difference / n);
  }
  deltas.sort((a, b) => a - b);
  return { status: 'available', reason: null, games: rows.length, observations, modelMean, baselineMean, delta: modelMean - baselineMean, improvementPercent: baselineMean ? 100 * (baselineMean - modelMean) / baselineMean : null, delta95: [quantile(deltas, .025), quantile(deltas, .975)], seed, replicates };
}

function comparison(actual: number, original: ImpactComparison, homeTeam: string, awayTeam: string, playIds: string[]): ImpactComparison {
  const excess = actual - original.expectedHomeEp;
  const material = actual * excess > 0 ? Math.min(Math.abs(actual), Math.abs(excess)) : 0;
  return { ...original, actualHomeEp: actual, excessHomeEp: excess, statistic: material / Math.sqrt(1 + original.variance), favoredTeam: material > 0 ? actual > 0 ? homeTeam : awayTeam : null, playIds };
}

/** Sensitivity only: zero one modeled EP contribution; retain the realized path, expectations, variance and coverage. */
export function neutralizeImpactEvent(result: GameImpactResult, playId: string, homeTeam: string, awayTeam: string): GameImpactResult {
  if (result.events.filter(e => e.playId === playId).length !== 1) throw new Error('Sensitivity requires exactly one matching valued event.');
  const changed = structuredClone(result);
  changed.events = changed.events.map(e => e.playId === playId ? { ...e, homeEp: 0, homeWp: null, assumption: `Sensitivity only: modeled EP contribution neutralized. ${e.assumption}` } : e);
  changed.game = comparison(changed.events.reduce((n, e) => n + e.homeEp, 0), result.game, homeTeam, awayTeam, changed.events.map(e => e.playId));
  changed.drives = result.drives.map(d => {
    const events = changed.events.filter(e => e.driveId === d.driveId);
    return { driveId: d.driveId, ...comparison(events.reduce((n, e) => n + e.homeEp, 0), d, homeTeam, awayTeam, events.map(e => e.playId)) };
  }).sort((a, b) => b.statistic - a.statistic || a.driveId.localeCompare(b.driveId));
  const drive = changed.drives[0], isDrive = !!drive && drive.statistic > changed.game.statistic;
  const strongest = isDrive ? drive : changed.game;
  changed.maximum = strongest.statistic; changed.favoredTeam = strongest.favoredTeam;
  changed.strongest = isDrive ? 'drive' : 'game'; changed.strongestDrive = isDrive ? drive.driveId : null;
  return changed;
}

interface FrequencyGameLoss { gameId: string; n: number; logLoss: number; brier: number }
interface Diagnostic {
  year: number; games: number;
  frequency?: { byGame: FrequencyGameLoss[] }; leagueFrequency?: { byGame: FrequencyGameLoss[] };
  stateByGame?: { gameId: string; epN: number; epError: number; epBaselineError: number; wpN: number; wpError: number; wpScoreClockError: number }[];
}
type Prediction = GameImpactResult & { match: { homeTeam: string; awayTeam: string } };
interface Evaluation { schemaVersion: number; through: number; selection: unknown; provenance: Record<string, string>; predictions: Prediction[]; diagnostics: Diagnostic[] }
function frequencyPairs(d: Diagnostic): PairedGameLoss[] | null {
  if (!d.frequency?.byGame || !d.leagueFrequency?.byGame) return null;
  const baseline = new Map(d.leagueFrequency.byGame.map(r => [r.gameId, r]));
  if (baseline.size !== d.leagueFrequency.byGame.length || d.frequency.byGame.length !== baseline.size) throw new Error(`Unpaired frequency diagnostics for ${d.year}.`);
  return d.frequency.byGame.map(row => {
    const other = baseline.get(row.gameId);
    if (!other || other.n !== row.n) throw new Error(`Frequency opportunities differ for ${row.gameId}.`);
    return { gameId: row.gameId, observations: row.n, modelLoss: row.logLoss, baselineLoss: other.logLoss };
  });
}

function sensitivity(prediction: Prediction, history: CalibrationGame[]) {
  const calibration = calibrateImpact(prediction, history), rating = calibration.tailProbability === null ? null : officiatingTier(calibration.tailProbability);
  const changes = rating === null ? [] : prediction.events.map(event => {
    const altered = neutralizeImpactEvent(prediction, event.playId, prediction.match.homeTeam, prediction.match.awayTeam);
    const next = calibrateImpact(altered, history), afterRating = next.tailProbability === null ? null : officiatingTier(next.tailProbability);
    return { playId: event.playId, driveId: event.driveId, type: event.type, beneficiary: event.team, removedHomeEp: event.homeEp,
      rating: afterRating, tailProbability: next.tailProbability, maximum: altered.maximum, favoredTeam: altered.favoredTeam, strongest: altered.strongest, strongestDrive: altered.strongestDrive };
  });
  const graded = changes.flatMap(c => c.rating === null ? [] : [c.rating]);
  return { gameId: prediction.gameId, rating, tailProbability: calibration.tailProbability, maximum: prediction.maximum, favoredTeam: prediction.favoredTeam,
    reason: rating === null ? impactCoverageReason(prediction) ?? 'insufficient_calibration' : null,
    valuedEvents: prediction.events.length, acceptedPenalties: prediction.coverage.acceptedPenalties,
    minimumNeutralizedRating: graded.length ? Math.min(...graded) : rating, maximumNeutralizedRating: graded.length ? Math.max(...graded) : rating,
    ratingChangesAfterOneEvent: changes.some(c => c.rating !== rating), dropsAfterOneEvent: changes.some(c => c.rating !== null && rating !== null && c.rating < rating),
    noFlagAfterOneEvent: rating !== null && rating > 1 && changes.some(c => c.rating === 1), neutralizations: changes };
}

export async function evaluateStability(input: string, output: string, seed = 20260923, replicates = 5000): Promise<unknown> {
  const dataRoot = resolve('data'), outputPath = resolve(output);
  if (!outputPath.startsWith(`${dataRoot}${sep}`)) throw new Error('Stability output must stay under the ignored data directory.');
  const bytes = await readFile(input), evaluation = JSON.parse(bytes.toString('utf8')) as Evaluation;
  if (evaluation.schemaVersion !== 1 || !Array.isArray(evaluation.predictions) || !Array.isArray(evaluation.diagnostics)) throw new Error('Invalid officiating evaluation input.');
  const ids = new Set<string>();
  for (const result of evaluation.predictions) { if (!result.gameId || ids.has(result.gameId)) throw new Error('Duplicate evaluation prediction.'); ids.add(result.gameId); }
  const heldout = [2024, 2025].map(year => {
    const d = evaluation.diagnostics.find(d => d.year === year);
    if (!d) return { year, status: 'unavailable', reason: 'missing_year_diagnostics' };
    const frequency = frequencyPairs(d), states = d.stateByGame;
    return { year, sourceGames: d.games,
      frequencyLogLoss: frequency ? pairedGameBootstrap(frequency, (seed + year) >>> 0, replicates) : { status: 'unavailable', reason: 'missing_paired_frequency_diagnostics' },
      epMse: states ? pairedGameBootstrap(states.map(r => ({ gameId: r.gameId, observations: r.epN, modelLoss: r.epError, baselineLoss: r.epBaselineError })), (seed + year + 1000) >>> 0, replicates) : { status: 'unavailable', reason: 'missing_state_by_game_diagnostics' },
      wpBrierVsScoreClock: states ? pairedGameBootstrap(states.map(r => ({ gameId: r.gameId, observations: r.wpN, modelLoss: r.wpError, baselineLoss: r.wpScoreClockError })), (seed + year + 2000) >>> 0, replicates) : { status: 'unavailable', reason: 'missing_state_by_game_diagnostics' } };
  });
  const history = evaluation.predictions.map(calibrationGame).filter((g): g is CalibrationGame => g !== null);
  const current = evaluation.predictions.filter(p => p.season === 2026).map(p => sensitivity(p, history));
  const sourceHashes = Object.fromEntries(await Promise.all(['officiating-observations', 'officiating-frequency', 'officiating-state-model', 'officiating-impact'].map(async name => [name, createHash('sha256').update(await readFile(`packages/core/src/${name}.ts`)).digest('hex')])));
  const report = { schemaVersion: 1, input: resolve(input), inputChecksum: createHash('sha256').update(bytes).digest('hex'),
    scriptChecksum: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), producerProvenance: evaluation.provenance, currentProvenance: sourceHashes,
    producerMatchesCurrent: Object.entries(sourceHashes).every(([name, checksum]) => evaluation.provenance[name] === checksum), selection: evaluation.selection,
    method: { unit: 'paired whole-game cluster', replicates, seed, interval: '95% percentile bootstrap with linear-interpolated quantiles', estimand: 'pooled per-opportunity mean loss difference: model minus baseline; negative favors model', modelRefittedDuringBootstrap: false },
    heldout,
    sensitivity2026: { games: current.length, rated: current.filter(g => g.rating !== null).length, ratingChangesAfterOneEvent: current.filter(g => g.ratingChangesAfterOneEvent).length,
      dropsAfterOneEvent: current.filter(g => g.dropsAfterOneEvent).length, noFlagAfterOneEvent: current.filter(g => g.noFlagAfterOneEvent).length, gamesDetail: current },
    limitations: [
      'Game-cluster intervals account for within-game dependence but not residual dependence between games sharing teams, officials or seasons. Training-model uncertainty is not bootstrapped.',
      'Loss comparisons evaluate heldout predictive fit for observed calls and state outcomes, not incorrect-call accuracy, intent, or fairness labels.',
      'Neutralization sets one supported modeled EP contribution to zero while holding the realized plays/drives, opportunity expectations, variance, coverage and historical calibration fixed. It does not reconstruct a game without that penalty.',
      'Changing a rating after one event is sensitivity, not evidence that the event was incorrectly called. Neutralizing an opposing benefit can increase the other side’s anomaly score.',
      'Thresholds and production formulas are unchanged. Current-season sensitivity is descriptive; the frequency selection was frozen using earlier development seasons.',
    ] };
  await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); if (!arg.startsWith('--') || at < 3) throw new Error('Use --input=path --output=data/path --seed=integer --replicates=integer.'); return [arg.slice(2, at), arg.slice(at + 1)]; }));
  if (Object.keys(args).some(key => !['input', 'output', 'seed', 'replicates'].includes(key))) throw new Error('Unknown stability evaluation option.');
  const report = await evaluateStability(args.input ?? 'data/officiating-evaluation/impact-2026.json', args.output ?? 'data/officiating-evaluation/stability-2026.json', args.seed === undefined ? 20260923 : Number(args.seed), args.replicates === undefined ? 5000 : Number(args.replicates)) as { producerMatchesCurrent: boolean; heldout: unknown; sensitivity2026: Record<string, unknown> };
  const { gamesDetail: _gamesDetail, ...sensitivitySummary } = report.sensitivity2026;
  console.log(JSON.stringify({ producerMatchesCurrent: report.producerMatchesCurrent, heldout: report.heldout, sensitivity2026: sensitivitySummary }, null, 2));
}
