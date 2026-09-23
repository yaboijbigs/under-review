import { describe, expect, it } from 'vitest';
import { analysisSchema, gameAuditSchema, type AnalysisResult, type GameAudit } from '../packages/core/src/contracts.js';
import { getGameVerdict, getGameRatingBreakdown, SUSPICION_RULES_VERSION } from '../packages/core/src/consumer-summary.js';
import { getGameVerdict as legacyVerdict, getGameRatingBreakdown as legacyBreakdown } from '../packages/core/src/consumer-summary-v3.js';
import { validOfficiatingAudit, type OfficiatingAudit } from '../packages/core/src/officiating-contracts.js';
import { parseFeedbackRevision } from '../packages/core/src/visitor-feedback.js';
import { reportSummary } from '../packages/core/src/summaries.js';
import {renderSocialPost,recognizedPublicationFooter} from '../packages/core/src/social-post.js';
import { addExpectationCluster, expectationMarket, expectationsFixture } from './consumer-expectations.fixture.js';

function fixture(atLeastAsUnusual = 5) {
  const { game, audit } = expectationsFixture();
  const comparison = (actual: number, expected: number, variance: number, playIds: string[]) => {
    const excess = actual - expected, material = actual * excess > 0 ? Math.min(Math.abs(actual), Math.abs(excess)) : 0;
    return { actualHomeEp: actual, expectedHomeEp: expected, excessHomeEp: excess, variance,
      statistic: material / Math.sqrt(1 + variance), favoredTeam: material > 0 ? actual > 0 ? 'NYJ' : 'GB' : null, playIds };
  };
  const first = { ...comparison(4, 1, .4, ['100']), driveId: 'fixed_drive:1:NYJ' };
  const second = { ...comparison(-1, -.5, .6, ['200']), driveId: 'fixed_drive:2:GB' };
  const officiating: OfficiatingAudit = {
    version: 'under-review-officiating-v1', gameId: game.id, homeTeam: 'NYJ', awayTeam: 'GB', season: 2026,
    status: 'supported', reasonCode: null, scope: 'supported_regulation_penalty_enforcement',
    result: { gameId: game.id, season: 2026,
      events: [
        { playId: '100', driveId: first.driveId, team: 'NYJ', type: 'Defensive Holding', homeEp: 4, homeWp: null, observedHomeWpChange: .1, firstDownExtension: true, assumption: 'Observed incomplete pass stands without enforcement.' },
        { playId: '200', driveId: second.driveId, team: 'GB', type: 'False Start', homeEp: -1, homeWp: null, observedHomeWpChange: -.03, firstDownExtension: false, assumption: 'Same-clock state without presnap enforcement.' },
      ],
      game: comparison(3, .5, 1, ['100', '200']), drives: [first, second], maximum: first.statistic,
      strongest: 'drive', strongestDrive: first.driveId, favoredTeam: 'NYJ',
      rates: [
        { team: 'GB', family: 'defensive_pass', opportunities: 60, actual: 1, expected: 1 },
        { team: 'NYJ', family: 'offensive_presnap', opportunities: 60, actual: 1, expected: 1 },
      ],
      coverage: { opportunities: 120, modeledOpportunities: 120, acceptedPenalties: 2, modeledCalls: 2, excludedPenalties: 0, valuedPenalties: 2, statePairs: 2, missingDriveOpportunities: 0 },
      turningPoints: [],
    },
    calibration: { seasons: [2023, 2024, 2025], games: 999, atLeastAsUnusual, tailProbability: (atLeastAsUnusual + 1) / 1000, gameAtLeastAsUnusual: 300, gameTailProbability: .301 },
    reference: { version: 'under-review-officiating-reference-v1', checksum: 'a'.repeat(64), trainingSeasons: [2021, 2022, 2023, 2024, 2025], sourceChecksums: { 'synthetic-frozen-training': 'b'.repeat(64) } },
    crew: { status: 'missing', adjustmentApplied: false, roles: [] }, notes: [],
  };
  audit.version = 'under-review-game-audit-v6'; audit.officiating = officiating;
  return { game, audit, officiating };
}

describe('consumer v4 officiating ratings', () => {
  it.each([0,5,30,100,300])('renders the same evidence in bounded link-free tweet previews (%i)',matches=>{
    const {game,audit}=fixture(matches),analysis:AnalysisResult={schemaVersion:1,metrics:[],events:[],timeline:[],coverage:[],models:[],warnings:[],gameAudit:audit};
    const post=renderSocialPost(game,analysis,'https://underreview.jbigs.com/games/'+game.id,'initial','names');
    expect(post.valid).toBe(true);expect(post.weightedLength).toBeLessThanOrEqual(280);
    expect(post.text).not.toMatch(/https?:\/\/|box.score|spread|favored the winner|not fair/);
    expect(post.text).toMatch(/Week 2: [^\n]+\n\n/);
    expect(recognizedPublicationFooter(post.text,'game-final-screening-v5-names','unused')).toBe(true);
    expect(post.evidenceIds).toEqual([`verdict:${game.id}:game-suspicion-v4:joint-impact`]);
  });
  it.each([[4, 5], [5, 4], [29, 4], [30, 3], [99, 3], [100, 2], [199, 2], [200, 1]] as const)('uses only the joint calibrated tail at %i matches', (matches, rating) => {
    const { audit, officiating } = fixture(matches), before = structuredClone(audit);
    expect(validOfficiatingAudit(officiating)).toBe(true);
    expect(getGameVerdict(audit)).toMatchObject({ rating, rulesVersion: 'game-suspicion-v4', comparison: null });
    expect(audit).toEqual(before);
  });

  it('explains the supported directional effect without requiring the benefiting team to win', () => {
    const { audit } = fixture(4), verdict = getGameVerdict(audit);
    expect(verdict).toMatchObject({ rating: 5, label: 'RIGGED?', cluster: { team: 'NYJ', playIds: ['100'] } });
    expect(verdict.summary).toContain('penalty benefit for NYJ');
    expect(verdict.reasons).toEqual(['Estimated net penalty benefit: 4.0 expected points for NYJ on the strongest drive.', 'As unusual or more in 4 of 999 earlier games.']);
    expect(verdict.reasons.join(' ')).not.toMatch(/winner|unfair|rigged|incorrect|manipulation/i);
    expect(verdict.evidenceNote).toContain('missed fouls are not measured');
  });

  it('describes a game-wide signal without presenting it as one penalty drive', () => {
    const { audit, officiating } = fixture(5), result = officiating.result!;
    result.events[1].homeEp = 3; result.events[1].team = 'NYJ'; result.events[1].type = 'Defensive Holding';
    Object.assign(result.drives[1], { actualHomeEp: 3, excessHomeEp: 3.5, statistic: 3 / Math.sqrt(1.6), favoredTeam: 'NYJ' });
    Object.assign(result.game, { actualHomeEp: 7, excessHomeEp: 6.5, statistic: 6.5 / Math.sqrt(2), favoredTeam: 'NYJ' });
    result.maximum = result.game.statistic; result.strongest = 'game'; result.strongestDrive = null;
    result.rates[0].actual = 2; result.rates[1].actual = 0;
    expect(validOfficiatingAudit(officiating)).toBe(true);
    const verdict = getGameVerdict(audit);
    expect(verdict).toMatchObject({ rating: 4, cluster: null });
    expect(verdict.summary).toContain('across the game');
    expect(verdict.reasons[0]).toBe('Estimated net penalty benefit: 7.0 expected points for NYJ across the game.');
    expect(getGameRatingBreakdown(audit).families[0].evidence).toContain('The strongest signal came from the game as a whole.');
  });

  it('keeps spread, box score, raw penalty clusters and momentum outside the rating', () => {
    const { audit } = fixture(800), before = getGameVerdict(audit);
    audit.expectations = expectationsFixture({ outcomeCount: 0, penaltyCount: 0 }).audit.expectations;
    audit.market = expectationMarket(0); addExpectationCluster(audit, 5);
    audit.officiating!.result!.turningPoints.push({ playId: 'other-play', homeWpChange: .99, penalty: false, driveId: null });
    const changed = getGameVerdict(audit);
    expect(changed.rating).toBe(1); expect(changed.reasons).toEqual(before.reasons); expect(changed.cluster).toBeNull();
  });

  it('does not require complete box-score aggregates for a supported officiating rating', () => {
    const { audit } = fixture();
    for (const profile of audit.profiles) {
      profile.totalYards = null; profile.opponentYards = null; profile.penalties = null; profile.penaltyYards = null; profile.turnoverMargin = null;
    }
    delete audit.market; delete audit.expectations;
    expect(getGameVerdict(audit).rating).toBe(4);
  });

  it.each(['missing', 'limited', 'corrupt-statistic', 'corrupt-tail', 'missing-coverage', 'foreign-game', 'future-reference', 'wrong-reference-version'] as const)('withholds a v4 rating for %s evidence even when legacy flags are strong', (kind) => {
    const { audit } = fixture(); audit.expectations = expectationsFixture({ outcomeCount: 0 }).audit.expectations; addExpectationCluster(audit, 3);
    if (kind === 'missing') delete audit.officiating;
    if (kind === 'limited') audit.officiating!.status = 'limited';
    if (kind === 'corrupt-statistic') audit.officiating!.result!.maximum += 1;
    if (kind === 'corrupt-tail') audit.officiating!.calibration.tailProbability = .000001;
    if (kind === 'missing-coverage') audit.officiating!.result!.coverage.modeledOpportunities = 0;
    if (kind === 'foreign-game') audit.profiles[0].gameId = '2026_01_OTHER_GAME';
    if (kind === 'future-reference') audit.officiating!.reference.trainingSeasons[4] = 2026;
    if (kind === 'wrong-reference-version') (audit.officiating!.reference as { version: string }).version = 'unknown-v99';
    expect(getGameVerdict(audit)).toMatchObject({ rating: null, label: 'Unrated', reasons: [], cluster: null });
    expect(getGameRatingBreakdown(audit)).toMatchObject({ status: 'unavailable', families: [], thresholds: [] });
  });

  it('preserves awaiting behavior and does not downgrade missing evidence to Fair', () => {
    expect(getGameVerdict(fixture().audit, false)).toMatchObject({ level: 'awaiting', rating: null, shortLabel: 'Awaiting data' });
    expect(getGameVerdict(undefined, false)).toMatchObject({ level: 'awaiting', rating: null });
    expect(getGameVerdict(null)).toMatchObject({ level: 'limited', rating: null });
    expect(SUSPICION_RULES_VERSION).toBe('game-suspicion-v4');
  });

  it.each([1, 2, 3, 4, 5])('preserves byte-for-byte verdict and breakdown behavior for audit v%i', (version) => {
    const { audit } = expectationsFixture({ outcomeCount: 5 }); addExpectationCluster(audit, 3); audit.market = expectationMarket(0);
    audit.version = `under-review-game-audit-v${version}`;
    expect(getGameVerdict(audit)).toEqual(legacyVerdict(audit));
    expect(getGameVerdict(audit, false)).toEqual(legacyVerdict(audit, false));
    expect(getGameRatingBreakdown(audit)).toEqual(legacyBreakdown(audit));
  });

  it('uses one joint rating and contextual components without applying the old comparison multiplier', () => {
    const { audit } = fixture(4), breakdown = getGameRatingBreakdown(audit);
    expect(breakdown).toMatchObject({ status: 'available', rating: 5, rulesVersion: 'game-suspicion-v4', thresholdLabel: 'Calibrated rarity', corroboration: null });
    expect(breakdown.families[0]).toMatchObject({ id: 'joint-impact', status: 'eligible', eligibleRating: 5, tailProbability: .005, adjustedTailProbability: .005, rarityLabel: 'Calibrated rarity' });
    expect(breakdown.families.slice(1).every(f => f.status === 'context' && f.eligibleRating === null && f.tailProbability === null)).toBe(true);
    expect(breakdown.thresholds.at(-1)).toEqual({ rating: 5, label: 'RIGGED?', adjustedTailAtMost: .005 });
    expect(breakdown.notes.join(' ')).toContain('spread and momentum are context only');
    expect(breakdown.combinationRule).toContain('Signals are not added');
  });

  it('retains the new payload through persisted analysis parsing', () => {
    const { audit } = fixture();
    expect(gameAuditSchema.parse(audit).officiating).toEqual(audit.officiating);
    const analysis: AnalysisResult = { schemaVersion: 1, metrics: [], events: [], timeline: [], coverage: [], models: [], warnings: [], gameAudit: audit };
    expect(analysisSchema.parse(analysis).gameAudit?.officiating).toEqual(audit.officiating);
  });

  it.each(['game-suspicion-v2', 'game-suspicion-v3', 'game-suspicion-v4'])('accepts feedback references for supported historical rules %s', rulesVersion => {
    expect(parseFeedbackRevision({ revisionId: 'c1111111-1111-4111-8111-111111111111', rulesVersion }).rulesVersion).toBe(rulesVersion);
  });

  it('uses the v4 verdict in saved report summaries without restoring review annotations', () => {
    const { game, audit } = fixture();
    const analysis: AnalysisResult = { schemaVersion: 1, metrics: [], events: [], timeline: [], coverage: [], models: [], warnings: [], gameAudit: audit };
    const summary = reportSummary(game, analysis);
    expect(summary).toContain('Sus 4/5.'); expect(summary).toContain(getGameVerdict(audit).summary);
    expect(summary).not.toContain('Officiating correctness');
  });
});
