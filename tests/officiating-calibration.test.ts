import { describe, expect, it } from 'vitest';
import { calibrateImpact, calibratedRating, calibrationGame, type CalibrationGame } from '../packages/core/src/officiating-calibration.js';
import type { GameImpactResult, ImpactComparison } from '../packages/core/src/officiating-impact.js';
import { neutralizeImpactEvent, pairedGameBootstrap } from '../scripts/evaluate-officiating-stability.js';

function comparison(actual: number, expected = 0, variance = 0, playIds = ['1']): ImpactComparison {
  const excess = actual - expected, material = actual * excess > 0 ? Math.min(Math.abs(actual), Math.abs(excess)) : 0;
  return { actualHomeEp: actual, expectedHomeEp: expected, excessHomeEp: excess, variance, statistic: material / Math.sqrt(1 + variance), favoredTeam: material > 0 ? actual > 0 ? 'AAA' : 'BBB' : null, playIds };
}
function result(score = 1): GameImpactResult {
  return { gameId: '2026_01_BBB_AAA', season: 2026,
    events: [{ playId: '1', driveId: 'd1', team: 'AAA', type: 'Defensive Holding', homeEp: score, homeWp: .01, observedHomeWpChange: .01, firstDownExtension: true, assumption: 'Synthetic test state contrast.' }],
    game: comparison(score), drives: [{ driveId: 'd1', ...comparison(score) }], maximum: score, strongest: 'game', strongestDrive: null, favoredTeam: score > 0 ? 'AAA' : null,
    rates: [{ team: 'BBB', family: 'defensive_pass', opportunities: 100, actual: 1, expected: .5 }],
    coverage: { opportunities: 100, modeledOpportunities: 100, acceptedPenalties: 1, modeledCalls: 1, excludedPenalties: 0, valuedPenalties: 1, statePairs: 1, missingDriveOpportunities: 0 }, turningPoints: [] };
}
function history(n = 599, exceedances = 2): CalibrationGame[] {
  return Array.from({ length: n }, (_, i) => ({ gameId: `${2023 + i % 3}_test_${i}`, season: 2023 + i % 3, maximum: i < exceedances ? 1 : .5, gameStatistic: i < exceedances ? 1 : .25 }));
}

describe('chronological game-maximum calibration', () => {
  it('ignores current/future/too-old seasons and the target game itself', () => {
    const data = history(), baseline = calibrateImpact(result(), data);
    const added = [{ gameId: '2026_future', season: 2026, maximum: 100, gameStatistic: 100 }, { gameId: '2027_future', season: 2027, maximum: 100, gameStatistic: 100 }, { gameId: '2022_old', season: 2022, maximum: 100, gameStatistic: 100 }, { gameId: result().gameId, season: 2025, maximum: 100, gameStatistic: 100 }];
    expect(calibrateImpact(result(), data.concat(added))).toEqual(baseline);
    expect(baseline).toMatchObject({ seasons: [2023, 2024, 2025], games: 599, atLeastAsUnusual: 2, tailProbability: .005, gameAtLeastAsUnusual: 2, gameTailProbability: .005 });
  });
  it('requires at least500 games covering all three earlier seasons', () => {
    expect(calibrateImpact(result(), history(499)).tailProbability).toBeNull();
    expect(calibrateImpact(result(), history(500)).tailProbability).not.toBeNull();
    const twoYears = history(600).map((g, i) => ({ ...g, season: 2024 + i % 2 }));
    expect(calibrateImpact(result(), twoYears)).toMatchObject({ games: 600, tailProbability: null, gameAtLeastAsUnusual: null, gameTailProbability: null });
  });
  it('rejects duplicate eligible game IDs rather than counting repeated revisions', () => {
    const data = history(); expect(() => calibrateImpact(result(), [...data, data[0]])).toThrow(/Duplicate/);
  });
  it.each([
    { maximum: Number.NaN, gameStatistic: 0 }, { maximum: Infinity, gameStatistic: 0 },
    { maximum: 1, gameStatistic: -1 }, { maximum: .5, gameStatistic: 1 },
    { maximum: 1, gameStatistic: Infinity },
  ])('rejects invalid historical statistics %j', patch => {
    const data = history(); data[0] = { ...data[0], ...patch };
    expect(() => calibrateImpact(result(), data)).toThrow(/Invalid/);
  });
  it.each([Number.NaN, Infinity, -1])('rejects invalid target maximum %s before calculating a tier', maximum => {
    const target = result(); target.maximum = maximum;
    expect(() => calibratedRating(target, history())).toThrow();
  });
  it('rejects a target maximum below its whole-game statistic', () => {
    const target = result(); target.maximum = .5;
    expect(() => calibrateImpact(target, history())).toThrow();
  });
  it('includes ties at the target score and keeps zero-statistic targets ordinary', () => {
    expect(calibrateImpact(result(), history()).atLeastAsUnusual).toBe(2);
    const target = result(0); target.events = []; target.game.playIds = []; target.drives[0].playIds = [];
    target.coverage.acceptedPenalties = 0; target.coverage.modeledCalls = 0; target.coverage.valuedPenalties = 0; target.coverage.statePairs = 0;
    const zeroHistory = history().map(g => ({ ...g, maximum: 0, gameStatistic: 0 }));
    expect(calibrateImpact(target, zeroHistory)).toMatchObject({ atLeastAsUnusual: 599, tailProbability: 1, gameAtLeastAsUnusual: 599, gameTailProbability: 1 });
    expect(calibratedRating(target, zeroHistory)).toBe(1);
  });
  it.each([[2, 5], [3, 4], [17, 4], [18, 3], [59, 3], [60, 2], [119, 2], [120, 1]])('preserves inclusive tail cutoff with %i exceedances: tier%i', (exceedances, tier) => {
    expect(calibratedRating(result(), history(599, exceedances))).toBe(tier);
  });
  it('does not put unsupported target games into calibration or give them a tier', () => {
    const target = result(); target.coverage.valuedPenalties = 0; target.events = [];
    expect(calibrationGame(target)).toBeNull(); expect(calibratedRating(target, history())).toBeNull();
  });
});

describe('paired whole-game bootstrap', () => {
  it('is seeded, input-order independent and retains complete paired game observations', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ gameId: String(i), observations: i + 10, modelLoss: i + 5, baselineLoss: i + 7 }));
    const a = pairedGameBootstrap(rows, 7, 1000), b = pairedGameBootstrap([...rows].reverse(), 7, 1000);
    expect(a).toEqual(b); expect(a.games).toBe(30); expect(a.delta95![1]).toBeLessThan(0);
    expect(a.observations).toBe(rows.reduce((sum, r) => sum + r.observations, 0));
  });
  it('reports pooled per-opportunity loss rather than giving differently sized games equal loss weight', () => {
    const compared = pairedGameBootstrap([{ gameId: 'a', observations: 1, modelLoss: 0, baselineLoss: 1 }, { gameId: 'b', observations: 9, modelLoss: 9, baselineLoss: 0 }], 1, 100);
    expect(compared.modelMean).toBe(.9); expect(compared.baselineMean).toBe(.1); expect(compared.delta).toBe(.8);
  });
  it('has an exact interval when every game has the same loss difference per observation', () => {
    const compared = pairedGameBootstrap([{ gameId: 'a', observations: 10, modelLoss: 10, baselineLoss: 20 }, { gameId: 'b', observations: 20, modelLoss: 20, baselineLoss: 40 }], 1, 100);
    expect(compared.delta95).toEqual([-1, -1]);
  });
  it('fails closed on duplicate, unpaired or invalid loss rows', () => {
    const row = { gameId: 'a', observations: 1, modelLoss: 0, baselineLoss: 1 };
    expect(() => pairedGameBootstrap([row, row])).toThrow();
    expect(() => pairedGameBootstrap([{ ...row, modelLoss: Number.NaN }])).toThrow();
    expect(() => pairedGameBootstrap([{ ...row, observations: 0 }])).toThrow();
    expect(pairedGameBootstrap([row]).status).toBe('unavailable');
  });
});

describe('leave-one-valued-event-out sensitivity', () => {
  it('neutralizes only the selected EP contribution and recomputes the maximum without changing opportunity assumptions', () => {
    const target = result(2.5), first = target.events[0];
    target.events.push({ ...first, playId: '2', homeEp: 1.5 }, { ...first, playId: '3', driveId: 'd2', team: 'BBB', homeEp: -1 });
    target.game = comparison(3, .5, 1, ['1', '2', '3']);
    target.drives = [{ driveId: 'd1', ...comparison(4, .5, 1, ['1', '2']) }, { driveId: 'd2', ...comparison(-1, 0, 0, ['3']) }];
    target.maximum = target.drives[0].statistic; target.strongest = 'drive'; target.strongestDrive = 'd1';
    target.coverage.acceptedPenalties = 3; target.coverage.modeledCalls = 3; target.coverage.valuedPenalties = 3; target.coverage.statePairs = 3;
    const before = structuredClone(target), changed = neutralizeImpactEvent(target, '1', 'AAA', 'BBB');
    expect(target).toEqual(before); expect(changed.coverage).toEqual(before.coverage); expect(changed.rates).toEqual(before.rates);
    expect(changed.game).toMatchObject({ actualHomeEp: .5, expectedHomeEp: .5, variance: 1, statistic: 0 });
    expect(changed.drives.find(d => d.driveId === 'd1')).toMatchObject({ actualHomeEp: 1.5, expectedHomeEp: .5, variance: 1 });
    expect(changed).toMatchObject({ maximum: 1, strongest: 'drive', strongestDrive: 'd2', favoredTeam: 'BBB' });
    expect(changed.events[0]).toMatchObject({ homeEp: 0, homeWp: null });
    expect(() => neutralizeImpactEvent(target, 'absent', 'AAA', 'BBB')).toThrow();
  });
  it('keeps one-event games eligible and calibrates their zero contribution against unchanged history', () => {
    const target = result(), calibration = history(), before = structuredClone(calibration);
    const changed = neutralizeImpactEvent(target, '1', 'AAA', 'BBB');
    expect(calibratedRating(target, calibration)).toBe(5); expect(calibratedRating(changed, calibration)).toBe(1);
    expect(changed.coverage.valuedPenalties).toBe(1); expect(calibration).toEqual(before);
  });
});
