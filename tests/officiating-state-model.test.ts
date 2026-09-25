import { describe, expect, it } from 'vitest';
import type { OfficiatingGameObservation, OfficiatingOpportunity, OfficiatingState } from '../packages/core/src/officiating-observations.js';
import { estimateState, estimateStateBaseline, fitStateModel, prepareStateEstimator, prepareStateModel, stateModelChecksum, stateModelInputReason, validStateModel } from '../packages/core/src/officiating-state-model.js';

const state = (patch: Partial<OfficiatingState> = {}): OfficiatingState => ({ possessionTeam: 'AAA', defenseTeam: 'BBB', quarter: 2, down: 1, yardsToGo: 10, yardline100: 50, halfSecondsRemaining: 600, gameSecondsRemaining: 2400, scoreDifference: 0, possessionTimeouts: 3, defenseTimeouts: 3, receivesSecondHalfKickoff: 1, ...patch });
const opportunity = (playId: string, s: OfficiatingState, nextScore: OfficiatingOpportunity['labels']['nextScore'] = 3, homeWin: OfficiatingOpportunity['labels']['homeWin'] = 1): OfficiatingOpportunity => ({ playId, order: Number(playId), driveId: null, state: s, playKind: 'run', penaltyStatus: 'none', penalty: null, penaltyExclusionReason: null, observedHomeWpChange: null, labels: { nextScore, homeWin } });
const game = (id: number, opportunities: OfficiatingOpportunity[], season = 2025): OfficiatingGameObservation => ({ schemaVersion: 1, gameId: `${season}_01_AAA_BBB_${id}`, season, week: 1, gameType: 'REG', homeTeam: 'AAA', awayTeam: 'BBB', opportunities, coverage: { inputRows: opportunities.length, uniqueRows: opportunities.length, duplicateRows: 0, conflictingPlayIds: 0, excludedRows: {}, regulationOpportunities: opportunities.length, overtimeOpportunities: 0, unknownPlayKind: 0, incompleteStates: 0, acceptedPenalties: 0, excludedPenalties: 0, valuedStatePairs: 0, valuationExclusions: {}, nextScoreLabels: opportunities.length, missingNextScoreLabels: 0 } });

// Every play label is synthetic test data, never a claimed football estimate. Distinct games matter.
function training(games = 100): OfficiatingGameObservation[] {
  return Array.from({ length: games }, (_, g) => game(g, Array.from({ length: 80 }, (_, p) => {
    const down = 1 + p % 4, yardline100 = 15 + 10 * (Math.floor(p / 4) % 8), yardsToGo = p < 40 ? 5 : 10;
    const scoreDifference = g % 2 === 0 ? 7 : -7;
    const label = yardline100 <= 35 ? 7 : yardline100 <= 65 ? 3 : -2;
    return opportunity(String(p), state({ down, yardline100, yardsToGo, scoreDifference }), label, g % 2 === 0 ? 1 : 0);
  })));
}
const rows = training();
const model = fitStateModel(2026, rows);

describe('chronological empirical state fit', () => {
  it('fits only the earlier five regular seasons, independent of input order', () => {
    expect(validStateModel(model)).toBe(true);
    expect(model.ep).toMatchObject({ observations: 8000, games: 100, converged: true });
    expect(model.wp.converged).toBe(true);
    const future = game(1001, rows[0].opportunities, 2026), old = game(1002, rows[0].opportunities, 2020), post = { ...game(1003, rows[0].opportunities), gameType: 'POST' };
    const fitted = fitStateModel(2026, [...rows].reverse().concat([future, old, post]));
    expect(fitted.ep).toEqual(model.ep);
    expect(fitted.wp).toEqual(model.wp);
    expect(fitted.support).toEqual(model.support);
    expect(fitted.trainingSeasons).toEqual([2025]);
  });
  it('does not train on provider probability movement and stores no training rows', () => {
    const altered = rows.map(g => ({ ...g, opportunities: g.opportunities.map(p => ({ ...p, observedHomeWpChange: 1 })) }));
    expect(fitStateModel(2026, altered)).toEqual(model);
    expect(JSON.stringify(model).length).toBeLessThan(30000);
    expect(validStateModel(JSON.parse(JSON.stringify(model)))).toBe(true);
  });
  it('deduplicates identical games and plays; conflicting evidence is withheld', () => {
    const duplicate = fitStateModel(2026, [...rows, rows[0]]);
    expect(duplicate.ep).toEqual(model.ep);
    expect(duplicate.support).toEqual(model.support);
    const repeatedPlays = rows.map(g => ({ ...g, opportunities: [...g.opportunities, g.opportunities[0]] }));
    expect(fitStateModel(2026, repeatedPlays).ep).toEqual(model.ep);
    const conflict = structuredClone(rows[0]); conflict.opportunities[0].labels.nextScore = -7;
    const refused = fitStateModel(2026, [...rows, conflict]);
    expect(refused.coverage.conflictingGames).toBe(1);
    expect(refused.ep.games).toBe(99);
    expect(refused.ep.coefficients).toBeNull();
  });
  it('does not inflate distinct-game support by repeating many states', () => {
    const repeated = fitStateModel(2026, [game(1, Array.from({ length: 6000 }, (_, i) => opportunity(String(i), state())))]);
    expect(estimateState(repeated, state(), 'AAA')).toMatchObject({ status: 'unavailable', reasonCode: 'insufficient_ep_training', ep: null, support: { games: 1 } });
  });
});

describe('continuous supported regulation estimates', () => {
  it('produces a signed same-clock state contrast for field advancement without bin jumps', () => {
    const before = estimateState(model, state({ yardline100: 51 }), 'AAA');
    const after = estimateState(model, state({ yardline100: 46, yardsToGo: 5 }), 'AAA');
    expect(before.status).toBe('experimental'); expect(after.status).toBe('experimental');
    expect(after.ep! - before.ep!).toBeGreaterThan(0);
    expect(after.homeWp!).toBeGreaterThanOrEqual(before.homeWp!);
    const left = estimateState(model, state({ yardline100: 40.00001 }), 'AAA');
    const right = estimateState(model, state({ yardline100: 39.99999 }), 'AAA');
    expect(right.ep!).toBeGreaterThanOrEqual(left.ep!);
    expect(Math.abs(right.ep! - left.ep!)).toBeLessThan(.0001);
    expect(estimateState(model, state({ yardline100: 56, yardsToGo: 15 }), 'AAA').reasonCode).toBe('insufficient_local_ep_support');
  });
  it('is monotone in field position and distance even with adverse noisy labels', () => {
    const adverse = fitStateModel(2026, rows.map(g => ({ ...g, opportunities: g.opportunities.map(p => ({ ...p, labels: { ...p.labels, nextScore: p.state.yardline100! > 65 ? 7 : -7 } as OfficiatingOpportunity['labels'] })) })));
    let prior = -Infinity;
    for (let yard = 95; yard >= 15; yard--) {
      const value = estimateState(adverse, state({ yardline100: yard }), 'AAA');
      expect(value.status).toBe('experimental');
      expect(value.ep!).toBeGreaterThanOrEqual(prior - 1e-12); prior = value.ep!;
    }
    expect(estimateState(model, state({ yardsToGo: 4 }), 'AAA').ep!).toBeGreaterThanOrEqual(estimateState(model, state({ yardsToGo: 6 }), 'AAA').ep!);
  });
  it('returns bounded EP and correctly orients home/away win credit including ties', () => {
    const tied = fitStateModel(2026, rows.map(g => ({ ...g, opportunities: g.opportunities.map(p => ({ ...p, labels: { nextScore: 0, homeWin: .5 } })) })));
    const a = estimateState(tied, state(), 'AAA'), b = estimateState(tied, state(), 'BBB');
    expect(a.ep).toBeCloseTo(0); expect(a.homeWp).toBeCloseTo(.5); expect(a.awayWp).toBeCloseTo(.5); expect(b.homeWp).toBeCloseTo(.5);
    const own = estimateState(model, state({ scoreDifference: 7 }), 'AAA');
    const away = estimateState(model, state({ scoreDifference: 7 }), 'BBB');
    expect(own.homeWp!).toBeGreaterThan(.5); expect(away.homeWp!).toBeLessThan(.5);
    expect(own.ep).toBe(away.ep);
    expect(own.ep!).toBeGreaterThanOrEqual(-7); expect(own.ep!).toBeLessThanOrEqual(7);
    expect(own.homeWp! + own.awayWp!).toBeCloseTo(1);
  });
  it('provides chronological constant and score/clock baselines for heldout evaluation', () => {
    const baseline = estimateStateBaseline(model, state({ scoreDifference: 7 }), 'AAA');
    expect(baseline.ep).toBeCloseTo(model.baselines.epMean!);
    expect(baseline.homeWp).toBe(.5);
    expect(baseline.scoreClockHomeWp!).toBeGreaterThan(.5);
  });
  it('does not require WP labels for supported EP', () => {
    const noWp = fitStateModel(2026, rows.map(g => ({ ...g, opportunities: g.opportunities.map(p => ({ ...p, labels: { ...p.labels, homeWin: null } })) })));
    expect(estimateState(noWp, state(), 'AAA')).toMatchObject({ status: 'experimental', homeWp: null, awayWp: null, wpReasonCode: 'insufficient_wp_training' });
  });
  it('owns a deeply immutable prepared model while direct loaded-model calls still detect mutations', () => {
    expect(Object.isFrozen(model)).toBe(true); expect(Object.isFrozen(model.ep.coefficients)).toBe(true); expect(Object.isFrozen(model.support[0])).toBe(true);
    const loaded = structuredClone(model), prepared = prepareStateEstimator(loaded), expected = prepared.estimate(state(), 'AAA');
    expect(prepared.baseline(state(), 'AAA')).toEqual(estimateStateBaseline(model, state(), 'AAA'));
    loaded.ep.coefficients![0] += 5;
    expect(prepared.estimate(state(), 'AAA')).toEqual(expected);
    expect(estimateState(loaded, state(), 'AAA').reasonCode).toBe('invalid_state_model');
    expect(() => prepareStateEstimator(loaded)).toThrow('invalid_state_model');
  });
  it('prepares a JSON-loaded model for direct estimation without retaining mutable caller data', () => {
    const loaded = JSON.parse(JSON.stringify(model)), prepared = prepareStateModel(loaded), expected = estimateState(prepared, state(), 'AAA');
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.ep.coefficients)).toBe(true); expect(Object.isFrozen(prepared.support[0])).toBe(true);
    loaded.support[0].games = 0; loaded.ep.coefficients[0] += 5;
    expect(estimateState(prepared, state(), 'AAA')).toEqual(expected);
    expect(estimateState(prepared, state(), 'AAA')).toEqual(estimateState(model, state(), 'AAA'));
    expect(() => prepareStateModel(loaded)).toThrow('invalid_state_model');
    expect(() => prepareStateModel({ schemaVersion: 1 })).toThrow('invalid_state_model');
  });
});

describe('unavailable boundaries and loaded-model validation', () => {
  it.each([
    [{ quarter: 5 }, 'unsupported_overtime'],
    [{ yardline100: 0 }, 'unsupported_state_geometry'],
    [{ yardline100: 100 }, 'unsupported_state_geometry'],
    [{ yardsToGo: 0 }, 'unsupported_state_geometry'],
    [{ yardsToGo: 60, yardline100: 50 }, 'unsupported_state_geometry'],
    [{ halfSecondsRemaining: 0, gameSecondsRemaining: 1800 }, 'terminal_or_halftime'],
    [{ gameSecondsRemaining: 10 }, 'inconsistent_state_clocks'],
    [{ halfSecondsRemaining: null }, 'missing_or_invalid_state_fields'],
    [{ scoreDifference: Number.NaN }, 'missing_or_invalid_state_fields'],
    [{ possessionTimeouts: 4 }, 'unsupported_state_context'],
  ] as [Partial<OfficiatingState>, string][])('withholds %j', (patch, reasonCode) => {
    expect(stateModelInputReason(state(patch))).toBe(reasonCode);
    expect(estimateState(model, state(patch), 'AAA')).toMatchObject({ status: 'unavailable', ep: null, homeWp: null, reasonCode });
  });
  it('withholds sparse local states, invalid home identity, altered checksums and sign-violating coefficients', () => {
    expect(estimateState(model, state({ halfSecondsRemaining: 60, gameSecondsRemaining: 1860 }), 'AAA').reasonCode).toBe('insufficient_local_ep_support');
    expect(estimateState(model, state(), 'CCC').reasonCode).toBe('invalid_home_team');
    const altered = structuredClone(model); altered.ep.coefficients![0] += 1;
    expect(validStateModel(altered)).toBe(false);
    altered.checksum = stateModelChecksum(altered); expect(validStateModel(altered)).toBe(true);
    altered.ep.coefficients![8] = -1; altered.checksum = stateModelChecksum(altered);
    expect(validStateModel(altered)).toBe(false);
    expect(estimateState(altered, state(), 'AAA').reasonCode).toBe('invalid_state_model');
  });
  it('rejects current-season metadata or duplicate support cells even with a recomputed checksum', () => {
    const future = structuredClone(model); future.trainingSeasons = [2026]; future.checksum = stateModelChecksum(future);
    expect(validStateModel(future)).toBe(false);
    const duplicated = structuredClone(model); duplicated.support.push(duplicated.support[0]); duplicated.checksum = stateModelChecksum(duplicated);
    expect(validStateModel(duplicated)).toBe(false);
  });
});
