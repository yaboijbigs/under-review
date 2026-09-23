import { describe, expect, it } from 'vitest';
import { impactCoverageReason, OFFICIATING_REFERENCE_VERSION, officiatingAuditSchema, officiatingTier, validOfficiatingAudit, type OfficiatingAudit } from '../packages/core/src/officiating-contracts.js';

function comparison(actual: number, expected: number, variance: number, playIds: string[]) {
  const excess = actual - expected, material = actual * excess > 0 ? Math.min(Math.abs(actual), Math.abs(excess)) : 0;
  return { actualHomeEp: actual, expectedHomeEp: expected, excessHomeEp: excess, variance, statistic: material / Math.sqrt(1 + variance), favoredTeam: material > 0 ? actual > 0 ? 'AAA' : 'BBB' : null, playIds };
}
function fixture(): OfficiatingAudit {
  const first = comparison(6, 1, 1, ['1', '2']), second = comparison(-1, 0, 1, ['3']);
  return { version: 'under-review-officiating-v1', gameId: '2026_02_BBB_AAA', homeTeam: 'AAA', awayTeam: 'BBB', season: 2026, status: 'supported', reasonCode: null, scope: 'supported_regulation_penalty_enforcement',
    result: { gameId: '2026_02_BBB_AAA', season: 2026,
      events: [{ playId: '1', driveId: 'd1', team: 'AAA', type: 'Defensive Pass Interference', homeEp: 4, homeWp: .1, observedHomeWpChange: .05, firstDownExtension: true, assumption: 'Observed incomplete pass stands without enforcement.' },
        { playId: '2', driveId: 'd1', team: 'AAA', type: 'Defensive Holding', homeEp: 2, homeWp: .04, observedHomeWpChange: .03, firstDownExtension: false, assumption: 'Observed incomplete pass stands without enforcement.' },
        { playId: '3', driveId: 'd2', team: 'BBB', type: 'Encroachment', homeEp: -1, homeWp: -.02, observedHomeWpChange: -.01, firstDownExtension: false, assumption: 'Same-clock state without presnap enforcement.' }],
      game: comparison(5, 1, 2, ['1', '2', '3']), drives: [{ driveId: 'd1', ...first }, { driveId: 'd2', ...second }], maximum: first.statistic, strongest: 'drive', strongestDrive: 'd1', favoredTeam: 'AAA',
      rates: [{ team: 'BBB', family: 'defensive_pass', opportunities: 60, actual: 2, expected: 1 }, { team: 'AAA', family: 'defensive_presnap', opportunities: 40, actual: 1, expected: 1 }],
      coverage: { opportunities: 100, modeledOpportunities: 100, acceptedPenalties: 3, modeledCalls: 3, excludedPenalties: 0, valuedPenalties: 3, statePairs: 3, missingDriveOpportunities: 0 }, turningPoints: [] },
    calibration: { seasons: [2023, 2024, 2025], games: 780, atLeastAsUnusual: 7, tailProbability: 8 / 781, gameAtLeastAsUnusual: 31, gameTailProbability: 32 / 781 },
    reference: { version: OFFICIATING_REFERENCE_VERSION, checksum: 'a'.repeat(64), trainingSeasons: [2021, 2022, 2023, 2024, 2025], sourceChecksums: { 'https://example.test/immutable-reference': 'b'.repeat(64) } },
    crew: { status: 'missing', adjustmentApplied: false, roles: [] }, notes: [] };
}
function noEvents(): OfficiatingAudit {
  const audit = fixture(), r = audit.result!;
  r.events = []; r.game = comparison(0, .3, 1, []); r.drives = [{ driveId: 'd1', ...r.game }];
  r.maximum = 0; r.strongest = 'game'; r.strongestDrive = null; r.favoredTeam = null;
  r.coverage.acceptedPenalties = 0; r.coverage.modeledCalls = 0; r.coverage.valuedPenalties = 0; r.coverage.statePairs = 0;
  r.rates.forEach(rate => { rate.actual = 0; });
  audit.calibration.atLeastAsUnusual = 780; audit.calibration.tailProbability = 1; audit.calibration.gameAtLeastAsUnusual = 780; audit.calibration.gameTailProbability = 1;
  return audit;
}

describe('officiating consumer arithmetic validation', () => {
  it('accepts a consistent supported result and preserves the published tier boundaries', () => {
    expect(validOfficiatingAudit(fixture())).toBe(true);
    expect([.005, .03, .10, .20, 1].map(officiatingTier)).toEqual([5, 4, 3, 2, 1]);
  });
  it.each([
    ['duplicate event', (a: OfficiatingAudit) => { a.result!.events[1].playId = '1'; }],
    ['invented game member', (a: OfficiatingAudit) => { a.result!.game.playIds[0] = 'other'; }],
    ['omitted game member', (a: OfficiatingAudit) => { a.result!.game.playIds.pop(); }],
    ['duplicate drive', (a: OfficiatingAudit) => { a.result!.drives.push(a.result!.drives[0]); }],
    ['missing known drive', (a: OfficiatingAudit) => { a.result!.events[0].driveId = 'absent'; }],
    ['cross-drive event', (a: OfficiatingAudit) => { a.result!.drives[0].playIds = ['1', '3']; }],
    ['wrong drive sum', (a: OfficiatingAudit) => { a.result!.drives[0] = { driveId: 'd1', ...comparison(5, 1, 1, ['1', '2']) }; }],
    ['wrong game sum', (a: OfficiatingAudit) => { a.result!.game = comparison(6, 1, 2, ['1', '2', '3']); }],
    ['wrong beneficiary sign', (a: OfficiatingAudit) => { a.result!.events[0].team = 'BBB'; }],
    ['unrelated team', (a: OfficiatingAudit) => { a.result!.events[0].team = 'CCC'; }],
    ['inflated maximum', (a: OfficiatingAudit) => { a.result!.maximum += 1; }],
    ['wrong strongest drive', (a: OfficiatingAudit) => { a.result!.strongestDrive = 'd2'; }],
    ['wrong final beneficiary', (a: OfficiatingAudit) => { a.result!.favoredTeam = 'BBB'; }],
    ['residual mismatch', (a: OfficiatingAudit) => { a.result!.game.excessHomeEp += 1; }],
    ['statistic mismatch', (a: OfficiatingAudit) => { a.result!.game.statistic += 1; }],
  ])('rejects %s even when TypeScript type is asserted', (_, mutate) => {
    const a = fixture(); mutate(a); expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('allows missing-drive contributions only when their coverage and event membership agree', () => {
    const a = fixture(), r = a.result!;
    r.events[2].driveId = null; r.drives.pop(); r.coverage.missingDriveOpportunities = 1;
    expect(validOfficiatingAudit(a)).toBe(true);
    r.coverage.missingDriveOpportunities = 0;
    expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('requires complete drive expected/variance sums when no opportunities lack a drive', () => {
    const a = fixture(), r = a.result!;
    r.drives[1] = { driveId: 'd2', ...comparison(-1, .2, .5, ['3']) };
    expect(validOfficiatingAudit(a)).toBe(false);
    r.coverage.missingDriveOpportunities = 1;
    expect(validOfficiatingAudit(a)).toBe(true);
    r.drives[1] = { driveId: 'd2', ...comparison(-1, .2, 4, ['3']) };
    expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('chooses the game on a tie and rejects stale strongestDrive values', () => {
    const a = noEvents(); expect(validOfficiatingAudit(a)).toBe(true);
    a.result!.strongestDrive = 'd1'; expect(validOfficiatingAudit(a)).toBe(false);
    a.result!.strongest = 'drive'; expect(validOfficiatingAudit(a)).toBe(false);
  });
});

describe('coverage, provenance and calibration gates', () => {
  it.each([
    ['duplicated calibration year', (a: OfficiatingAudit) => { a.calibration.seasons = [2023, 2023, 2025]; }],
    ['partial calibration window', (a: OfficiatingAudit) => { a.calibration.seasons = [2025]; }],
    ['current-season calibration', (a: OfficiatingAudit) => { a.calibration.seasons = [2024, 2025, 2026]; }],
    ['old training window', (a: OfficiatingAudit) => { a.reference.trainingSeasons = [2020, 2021, 2022, 2023, 2024]; }],
    ['reordered training years', (a: OfficiatingAudit) => { a.reference.trainingSeasons.reverse(); }],
    ['wrong season identity', (a: OfficiatingAudit) => { a.result!.season = 2025; }],
    ['wrong game identity', (a: OfficiatingAudit) => { a.result!.gameId = '2026_02_CCC_AAA'; }],
    ['mismatched game ID year', (a: OfficiatingAudit) => { a.gameId = a.result!.gameId = '2025_02_BBB_AAA'; }],
    ['empty source provenance', (a: OfficiatingAudit) => { a.reference.sourceChecksums = {}; }],
    ['too few calibration games', (a: OfficiatingAudit) => { a.calibration.games = 499; }],
    ['impossible tail count', (a: OfficiatingAudit) => { a.calibration.atLeastAsUnusual = 781; }],
    ['wrong add-one tail', (a: OfficiatingAudit) => { a.calibration.tailProbability = .001; }],
    ['wrong whole-game tail', (a: OfficiatingAudit) => { a.calibration.gameTailProbability = .001; }],
    ['unpaired whole-game tail', (a: OfficiatingAudit) => { a.calibration.gameAtLeastAsUnusual = null; }],
    ['unpaired whole-game count', (a: OfficiatingAudit) => { a.calibration.gameTailProbability = null; }],
    ['supported with unavailable reason', (a: OfficiatingAudit) => { a.reasonCode = 'missing_data'; }],
  ])('rejects %s', (_, mutate) => {
    const a = fixture(); mutate(a); expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('allows the contextual whole-game calibration pair to be absent together', () => {
    const a = fixture(); a.calibration.gameAtLeastAsUnusual = null; a.calibration.gameTailProbability = null;
    expect(validOfficiatingAudit(a)).toBe(true);
  });
  it.each([
    ['event count differs from coverage', (a: OfficiatingAudit) => { a.result!.coverage.valuedPenalties = 2; }],
    ['state pairs exceed accepted calls', (a: OfficiatingAudit) => { a.result!.coverage.statePairs = 4; }],
    ['more missing drives than modeled opportunities', (a: OfficiatingAudit) => { a.result!.coverage.missingDriveOpportunities = 101; }],
    ['call rates exceed opportunities', (a: OfficiatingAudit) => { a.result!.rates[0].actual = 61; }],
    ['probability sum exceeds opportunities', (a: OfficiatingAudit) => { a.result!.rates[0].expected = 61; }],
    ['duplicate rates', (a: OfficiatingAudit) => { a.result!.rates.push(a.result!.rates[0]); }],
    ['rate calls differ from modeled calls', (a: OfficiatingAudit) => { a.result!.rates[0].actual = 1; }],
    ['event exceeds penalized-team recorded calls', (a: OfficiatingAudit) => { a.result!.rates[0].actual = 1; a.result!.rates[1].actual = 2; }],
    ['missing known-drive coverage', (a: OfficiatingAudit) => { const r = noEvents().result!; r.drives = []; a.result = r; }],
    ['contradictory turning-point event', (a: OfficiatingAudit) => { a.result!.turningPoints = [{ playId: '1', homeWpChange: .05, penalty: false, driveId: 'd1' }]; }],
  ])('rejects %s', (_, mutate) => {
    const a = fixture(); mutate(a); expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('requires verified sufficient crew context only when an adjustment was applied', () => {
    const a = fixture(); a.crew.adjustmentApplied = true;
    expect(validOfficiatingAudit(a)).toBe(false);
    a.crew.status = 'complete'; a.crew.roles = Array.from({ length: 5 }, (_, i) => ({ role: `role${i}`, name: `Official ${i}`, games: 20, actualCallsPerGame: 10, expectedCallsPerGame: 11, homeBenefitResidualPerGame: -.1 }));
    expect(validOfficiatingAudit(a)).toBe(true);
    a.crew.status = 'conflict'; expect(validOfficiatingAudit(a)).toBe(false);
    a.crew.adjustmentApplied = false; expect(validOfficiatingAudit(a)).toBe(true);
    a.crew.roles[1].name = a.crew.roles[0].name; expect(validOfficiatingAudit(a)).toBe(false);
  });
});

describe('zero-event meaning and untrusted runtime input', () => {
  it('allows zero accepted penalties with sufficient coverage, while wholly unsupported accepted penalties remain unavailable', () => {
    const clean = noEvents(); expect(validOfficiatingAudit(clean)).toBe(true);
    const unsupported = noEvents(); unsupported.result!.coverage.acceptedPenalties = 2;
    expect(impactCoverageReason(unsupported.result!)).toBe('no_supported_penalty_values');
    expect(validOfficiatingAudit(unsupported)).toBe(false);
  });
  it('cannot give an extreme calibrated tail to a zero statistic', () => {
    const a = noEvents(); a.calibration.atLeastAsUnusual = 0; a.calibration.tailProbability = 1 / 781;
    expect(validOfficiatingAudit(a)).toBe(false);
    a.calibration.atLeastAsUnusual = 780; a.calibration.tailProbability = 1;
    a.calibration.gameAtLeastAsUnusual = 0; a.calibration.gameTailProbability = 1 / 781;
    expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('does not use floating-point tolerance to promote a true zero into a rare positive result', () => {
    const a = noEvents(); a.result!.maximum = 1e-9; a.calibration.atLeastAsUnusual = 0; a.calibration.tailProbability = 1 / 781;
    expect(validOfficiatingAudit(a)).toBe(false);
    a.result!.game.statistic = 1e-9;
    expect(validOfficiatingAudit(a)).toBe(false);
    a.result!.game = comparison(1e-9, 0, 1, []); a.result!.drives = [{ driveId: 'd1', ...a.result!.game }]; a.result!.maximum = a.result!.game.statistic; a.result!.favoredTeam = 'AAA';
    a.calibration.gameAtLeastAsUnusual = 0; a.calibration.gameTailProbability = 1 / 781;
    expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('preserves the existing low-coverage and excluded-play thresholds', () => {
    const a = noEvents(); a.result!.coverage.opportunities = 59;
    expect(impactCoverageReason(a.result!)).toBe('insufficient_regulation_opportunity_coverage');
    a.result!.coverage.opportunities = 100; a.result!.coverage.modeledOpportunities = 79;
    expect(impactCoverageReason(a.result!)).toBe('insufficient_regulation_opportunity_coverage');
    a.result!.coverage.modeledOpportunities = 96; a.result!.coverage.excludedPenalties = 4;
    expect(impactCoverageReason(a.result!)).toBe('too_many_excluded_penalty_plays');
  });
  it.each([null, undefined, {}, [], 'supported', { status: 'supported' }])('fails closed without throwing for %j', input => {
    expect(validOfficiatingAudit(input)).toBe(false);
  });
  it.each([Number.NaN, Infinity, -Infinity])('rejects nonfinite numeric values %s at the schema boundary', bad => {
    const a = fixture(); a.result!.events[0].homeEp = bad;
    expect(officiatingAuditSchema.safeParse(a).success).toBe(false);
    expect(validOfficiatingAudit(a)).toBe(false);
  });
  it('rejects invalid model versions, unsafe counts and unbounded event values', () => {
    const version = { ...fixture(), reference: { ...fixture().reference, version: 'other-model' } };
    expect(validOfficiatingAudit(version)).toBe(false);
    const count = fixture(); count.calibration.games = Number.MAX_SAFE_INTEGER + 1;
    expect(validOfficiatingAudit(count)).toBe(false);
    const event = fixture(); event.result!.events[0].homeEp = 14.01;
    expect(validOfficiatingAudit(event)).toBe(false);
  });
});
