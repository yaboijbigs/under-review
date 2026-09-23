import { describe, expect, it } from 'vitest';
import { calculateGameImpact, fitImpactModel, valuePenalty, type ImpactModel } from '../packages/core/src/officiating-impact.js';
import { FREQUENCY_VERSION, type FrequencyModel } from '../packages/core/src/officiating-frequency.js';
import type { OfficiatingGameObservation, OfficiatingOpportunity, OfficiatingState } from '../packages/core/src/officiating-observations.js';
import { fitStateModel } from '../packages/core/src/officiating-state-model.js';

const state = (patch: Partial<OfficiatingState> = {}): OfficiatingState => ({ possessionTeam: 'AAA', defenseTeam: 'BBB', quarter: 2, down: 1, yardsToGo: 10, yardline100: 50, halfSecondsRemaining: 600, gameSecondsRemaining: 2400, scoreDifference: 0, possessionTimeouts: 3, defenseTimeouts: 3, receivesSecondHalfKickoff: 1, ...patch });
function opportunity(id: string, patch: Partial<OfficiatingOpportunity> = {}): OfficiatingOpportunity {
  return { playId: id, order: Number(id), driveId: '1', state: state(), playKind: 'run', penaltyStatus: 'none', penalty: null, penaltyExclusionReason: null, observedHomeWpChange: null, labels: { nextScore: 3, homeWin: .5 }, ...patch };
}
function game(plays: OfficiatingOpportunity[], season = 2026, id = 'game'): OfficiatingGameObservation {
  return { schemaVersion: 1, gameId: `${season}_${id}`, season, week: 1, gameType: 'REG', homeTeam: 'AAA', awayTeam: 'BBB', opportunities: plays,
    coverage: { inputRows: plays.length, uniqueRows: plays.length, duplicateRows: 0, conflictingPlayIds: 0, excludedRows: {}, regulationOpportunities: plays.length, overtimeOpportunities: 0, unknownPlayKind: 0, incompleteStates: 0, acceptedPenalties: plays.filter(p => p.penaltyStatus === 'accepted').length, excludedPenalties: 0, valuedStatePairs: plays.filter(p => p.penalty?.actualState).length, valuationExclusions: {}, nextScoreLabels: plays.length, missingNextScoreLabels: 0 } };
}
// Artificial labels provide a non-flat supported field-value surface solely for arithmetic regressions.
const training = Array.from({ length: 100 }, (_, index) => game(Array.from({ length: 80 }, (_, p) => {
  const yard = 15 + 10 * (p % 8), distance = p % 2 === 0 ? 5 : 10;
  return opportunity(String(p), { state: state({ yardline100: yard, yardsToGo: distance }), labels: { nextScore: yard <= 35 ? 7 : yard <= 65 ? 3 : -2, homeWin: .5 } });
}), 2025, String(index)));
const states = fitStateModel(2026, training);
const frequency = (): FrequencyModel => ({ version: FREQUENCY_VERSION, targetSeason: 2026, trainingSeasons: [2025], games: 500, prior: 200,
  base: { 'defensive_presnap:d': [10000, 100], 'offensive_presnap:o': [10000, 100] }, coarse: {}, context: {}, teams: {}, opponents: {}, crew: {} });
function impact(): ImpactModel {
  const model = fitImpactModel(2026, [], states);
  model.heads['defensive_presnap:d'] = [100, 100, 100, 100];
  model.heads['offensive_presnap:o'] = [100, 100, 100, 100];
  return model;
}
function called(id: string, homeBenefit = true, driveId = '1'): OfficiatingOpportunity {
  const s = homeBenefit ? state() : state({ possessionTeam: 'BBB', defenseTeam: 'AAA' });
  return opportunity(id, { state: s, driveId, playKind: 'unknown', penaltyStatus: 'accepted', penalty: { team: s.defenseTeam, type: 'Encroachment', family: 'defensive_presnap', yards: 5, firstDownExtension: false, actualState: { ...s, yardline100: 45, yardsToGo: 5 }, alternativeState: s, valuationReason: null, assumption: 'Test same-clock presnap enforcement.' } });
}

describe('supported enforcement cost and chronology', () => {
  it('withholds a current valued event when historical call or valued-call support is absent', () => {
    const p = called('1'), g = game([p]);
    expect(valuePenalty(p, g, states)?.homeEp).toBeGreaterThan(0);
    for (const cost of [undefined, [19, 19, 19, 19], [100, 19, 19, 19], [100, 0, 0, 0]] as const) {
      const m = fitImpactModel(2026, [], states);
      if (cost) m.heads['defensive_presnap:d'] = [...cost];
      const result = calculateGameImpact(g, frequency(), states, m);
      expect(result.events).toEqual([]);
      expect(result.game).toMatchObject({ actualHomeEp: 0, expectedHomeEp: 0, variance: 0, statistic: 0, favoredTeam: null });
      expect(result.coverage).toMatchObject({ acceptedPenalties: 1, valuedPenalties: 0, statePairs: 1 });
    }
  });
  it('does not pool nonzero ordinary costs into structurally unvalued late-half or missing states', () => {
    for (const patch of [{ halfSecondsRemaining: 120, gameSecondsRemaining: 1920 }, { possessionTimeouts: null }] as Partial<OfficiatingState>[]) {
      const p = called('1'); p.state = { ...p.state, ...patch };
      p.penalty!.actualState = null; p.penalty!.alternativeState = null;
      const m = impact();
      m.heads['defensive_presnap:d'] = [100, 100, 600, 3600];
      m.heads['offensive_presnap:o'] = [100, 100, 100, 100];
      m.contexts['defensive_presnap:d|1|medium|middle|late'] = [10, 0, 0, 0];
      const result = calculateGameImpact(game([p]), frequency(), states, m);
      expect(result.game.expectedHomeEp).toBe(0);
      expect(result.game.variance).toBe(0);
      expect(result.events).toEqual([]);
    }
  });
  it('learns supported-subset costs only from previous five REG seasons', () => {
    const historical = game([called('1')], 2025, 'past');
    const inputs = [historical, game([called('1')], 2026, 'target'), game([called('1')], 2027, 'future'), game([called('1')], 2020, 'old'), { ...game([called('1')], 2024, 'post'), gameType: 'POST' }];
    const fitted = fitImpactModel(2026, inputs.map(observation => ({ observation, crew: [] })), states);
    const expected = fitImpactModel(2026, [{ observation: historical, crew: [] }], states);
    expect(fitted).toEqual(expected);
    expect(fitted.heads['defensive_presnap:d'].slice(0, 2)).toEqual([1, 1]);
  });
  it('requires matching fit cutoff and the exact state-model checksum at scoring', () => {
    expect(() => fitImpactModel(2025, [], states)).toThrow();
    const m = impact();
    expect(m.stateModelChecksum).toBe(states.checksum);
    expect(() => calculateGameImpact(game([called('1')], 2025), frequency(), states, m)).toThrow();
    expect(() => calculateGameImpact(game([called('1')]), frequency(), states, { ...m, stateModelChecksum: '0'.repeat(64) })).toThrow();
    expect(() => calculateGameImpact(game([called('1')]), { ...frequency(), targetSeason: 2027 }, states, m)).toThrow();
  });
});

describe('descriptive signed impact arithmetic', () => {
  it('requires observed and excess impact to have the same direction', () => {
    const f = frequency(); f.base['defensive_presnap:d'] = [100, 99];
    const m = impact(); m.heads['defensive_presnap:d'] = [100, 100, 600, 3600]; delete m.heads['offensive_presnap:o'];
    const result = calculateGameImpact(game([called('1')]), f, states, m, 'league');
    expect(result.game.actualHomeEp).toBeGreaterThan(0);
    expect(result.game.excessHomeEp).toBeLessThan(0);
    expect(result.game.statistic).toBe(0);
    expect(result.game.favoredTeam).toBeNull();
  });
  it('does not score uncalled expected penalties as observed gifts', () => {
    const m = impact(); delete m.heads['offensive_presnap:o'];
    const result = calculateGameImpact(game([opportunity('1')]), frequency(), states, m);
    expect(result.game.expectedHomeEp).toBeGreaterThan(0);
    expect(result.game.excessHomeEp).toBeLessThan(0);
    expect(result.game).toMatchObject({ actualHomeEp: 0, statistic: 0, favoredTeam: null });
  });
  it('uses the smaller aligned effect and explicit variance stabilization', () => {
    const m = impact(); delete m.heads['offensive_presnap:o'];
    const result = calculateGameImpact(game([called('1')]), frequency(), states, m);
    const c = result.game;
    expect(c.actualHomeEp).toBeGreaterThan(c.expectedHomeEp);
    expect(c.statistic).toBeCloseTo(Math.min(Math.abs(c.actualHomeEp), Math.abs(c.excessHomeEp)) / Math.sqrt(1 + c.variance));
    expect(c.favoredTeam).toBe('AAA');
  });
  it('takes a maximum over whole game and drives instead of adding correlated scores', () => {
    const result = calculateGameImpact(game([called('1', true, 'a'), called('2', false, 'b')]), frequency(), states, impact());
    expect(result.game.actualHomeEp).toBeCloseTo(0);
    expect(result.game.statistic).toBeCloseTo(0);
    expect(result.drives).toHaveLength(2);
    expect(result.drives.every(d => d.statistic > 0)).toBe(true);
    expect(result.maximum).toBe(Math.max(result.game.statistic, ...result.drives.map(d => d.statistic)));
    expect(result.maximum).toBeLessThan(result.drives.reduce((sum, d) => sum + d.statistic, 0));
    expect(result.strongest).toBe('drive');
  });
  it('keeps whole-play WP movement contextual without substituting it for enforcement value', () => {
    const plain = called('1'), changed = { ...plain, observedHomeWpChange: -.9 };
    const a = calculateGameImpact(game([plain]), frequency(), states, impact());
    const b = calculateGameImpact(game([changed]), frequency(), states, impact());
    expect(b.game).toEqual(a.game); expect(b.maximum).toBe(a.maximum);
    expect(b.turningPoints).toEqual([{ playId: '1', homeWpChange: -.9, penalty: true, driveId: '1' }]);
  });
});
