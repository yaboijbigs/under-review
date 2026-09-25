import type { GameAudit } from './contracts.js';
import {
  getGameVerdict as legacyVerdict, getGameRatingBreakdown as legacyBreakdown,
  teamName, type GameVerdict as LegacyVerdict, type VerdictLevel,
  type GameRatingFamilyBreakdown as LegacyFamily, type GameRatingBreakdown as LegacyBreakdown,
} from './consumer-summary-v3.js';
import {
  officiatingAuditSchema, validOfficiatingAudit, officiatingTier, OFFICIATING_THRESHOLDS,
  type OfficiatingAudit,
} from './officiating-contracts.js';

export { teamName };
export type { VerdictLevel };
export const SUSPICION_RULES_VERSION = 'game-suspicion-v4';
export const SUSPICION_SCALE = [
  { level: 'fair', rating: 1, label: 'Fair', definition: 'No unusual one-sided benefit among the penalty effects we can estimate.' },
  { level: 'debatable', rating: 2, label: 'Debatable', definition: 'The estimated penalty benefit stands out against earlier games.' },
  { level: 'hmm', rating: 3, label: 'Hmm', definition: 'An unusual estimated penalty benefit across the game or one drive.' },
  { level: 'sus', rating: 4, label: 'Sus', definition: 'A very unusual estimated penalty benefit across the game or one drive.' },
  { level: 'extreme', rating: 5, label: 'RIGGED?', definition: 'An exceptionally unusual estimated penalty benefit; call correctness is not established.' },
] as const;

export interface GameVerdict extends Omit<LegacyVerdict, 'rulesVersion'> {
  rulesVersion: LegacyVerdict['rulesVersion'] | typeof SUSPICION_RULES_VERSION;
}
export interface GameRatingFamilyBreakdown extends Omit<LegacyFamily, 'id' | 'status' | 'eligibleRating'> {
  id: LegacyFamily['id'] | 'joint-impact' | 'game-impact' | 'drive-impact' | 'context';
  status: LegacyFamily['status'] | 'context';
  eligibleRating: 1 | 2 | 3 | 4 | 5 | null;
  rarityLabel?: string;
}
export interface GameRatingBreakdown extends Omit<LegacyBreakdown, 'rulesVersion' | 'families' | 'thresholds'> {
  rulesVersion: GameVerdict['rulesVersion'];
  families: GameRatingFamilyBreakdown[];
  thresholds: { rating: 2 | 3 | 4 | 5; label: string; adjustedTailAtMost: number }[];
  thresholdLabel?: string;
}

const earlierVersion = (audit: GameAudit | null | undefined): boolean => !!audit && /^under-review-game-audit-v[1-5]$/.test(audit.version);
const points = (value: number): string => Math.abs(value).toFixed(1);
const count = (value: number): string => new Intl.NumberFormat('en-US').format(value);

function supportedAudit(audit: GameAudit | null | undefined): OfficiatingAudit | null {
  if (audit?.version !== 'under-review-game-audit-v6') return null;
  const parsed = officiatingAuditSchema.safeParse(audit.officiating);
  if (!parsed.success || parsed.data.reference.version !== 'under-review-officiating-reference-v1' || !validOfficiatingAudit(parsed.data)) return null;
  const a = parsed.data, profiles = audit.profiles;
  if (profiles.length !== 2 || ![a.homeTeam, a.awayTeam].every(team => {
    const rows = profiles.filter(p => p.team === team);
    return rows.length === 1 && rows[0].gameId === a.gameId && rows[0].season === a.season
      && rows[0].opponent === (team === a.homeTeam ? a.awayTeam : a.homeTeam);
  })) return null;
  return a;
}

function selection(a: OfficiatingAudit) {
  const result = a.result!;
  return result.strongest === 'drive' ? result.drives.find(d => d.driveId === result.strongestDrive)! : result.game;
}
function netBenefit(value: number, a: OfficiatingAudit): string {
  return Math.abs(value) < .05 ? 'less than 0.1 expected points either way' : `${points(value)} expected points for ${value > 0 ? a.homeTeam : a.awayTeam}`;
}
function rarityReason(a: OfficiatingAudit): string {
  return `As unusual or more in ${count(a.calibration.atLeastAsUnusual)} of ${count(a.calibration.games)} earlier games.`;
}

/** V1–V5 retain their exact saved rules. V6 grades only the validated joint
 * regulation-enforcement statistic, never box-score, spread or momentum context.
 */
export function getGameVerdict(audit: GameAudit | null | undefined, hasAnalysis = true): GameVerdict {
  if (earlierVersion(audit)) return legacyVerdict(audit, hasAnalysis);
  const base: GameVerdict = {
    level: 'limited', label: 'Unrated', shortLabel: 'Unrated', rating: null,
    summary: 'There is not enough supported penalty evidence to rate this game.',
    definition: 'Outside the five-level scale until the supported evidence is sufficient.',
    reasons: [], rulesVersion: SUSPICION_RULES_VERSION, cluster: null, comparison: null,
    reviewCount: audit?.reviewCandidates.length ?? 0, tone: 'limited',
    evidenceNote: 'Supported regulation penalty effects; call correctness and missed fouls are not measured.',
  };
  if (!hasAnalysis) return { ...base, level: 'awaiting', label: 'Waiting for game data', shortLabel: 'Awaiting data',
    summary: 'The report appears automatically after complete final-game data arrives.', tone: 'waiting' };
  const a = supportedAudit(audit);
  if (!a) return base;
  const result = a.result!, selected = selection(a), rating = officiatingTier(a.calibration.tailProbability!);
  const tier = SUSPICION_SCALE[rating - 1], drive = result.strongest === 'drive';
  const emphasis = rating >= 5 ? 'exceptionally unusual' : rating >= 4 ? 'very unusual' : 'unusual';
  const summary = rating === 1 ? 'Supported penalties did not show an unusually one-sided benefit.'
    : `The penalty benefit for ${result.favoredTeam} was ${emphasis} ${drive ? 'on one drive' : 'across the game'}.`;
  const reason = `Estimated net penalty benefit: ${netBenefit(selected.actualHomeEp, a)} ${drive ? 'on the strongest drive' : 'across the game'}.`;
  return { ...base, ...tier, shortLabel: tier.label, summary, reasons: [reason, rarityReason(a)],
    cluster: rating >= 2 && drive && result.favoredTeam && selected.playIds.length ? { team: result.favoredTeam, playIds: [...selected.playIds] } : null,
    tone: rating >= 4 ? 'high' : rating === 3 ? 'elevated' : 'neutral' };
}

export function getGameRatingBreakdown(audit: GameAudit | null | undefined): GameRatingBreakdown {
  if (earlierVersion(audit)) return legacyBreakdown(audit);
  const verdict = getGameVerdict(audit);
  const base: GameRatingBreakdown = { status: 'unavailable', rulesVersion: verdict.rulesVersion, rating: verdict.rating,
    label: verdict.label, summary: verdict.summary, families: [], thresholds: [], combinationRule: '', corroboration: null, notes: [] };
  const a = supportedAudit(audit);
  if (!a || verdict.rating === null) return base;
  const result = a.result!, strongestDrive = [...result.drives].sort((x, y) => y.statistic - x.statistic || x.driveId.localeCompare(y.driveId))[0];
  const context = (id: 'game-impact' | 'drive-impact', title: string, evidence: string[]): GameRatingFamilyBreakdown => ({
    id, title, status: 'context', eligibleRating: null, eligibleLabel: null, evidence,
    tailProbability: null, adjustedTailProbability: null,
  });
  const families: GameRatingFamilyBreakdown[] = [
    { id: 'joint-impact', title: 'Overall penalty-impact rating', status: 'eligible', eligibleRating: verdict.rating, eligibleLabel: verdict.label,
      evidence: [rarityReason(a), result.strongest === 'drive' ? 'The strongest signal came from one drive.' : 'The strongest signal came from the game as a whole.'],
      tailProbability: a.calibration.tailProbability, adjustedTailProbability: a.calibration.tailProbability, rarityLabel: 'Calibrated rarity' },
    context('game-impact', 'Across the game', [
      `Estimated net benefit: ${netBenefit(result.game.actualHomeEp, a)}.`,
      `Expected net benefit for these opportunities: ${netBenefit(result.game.expectedHomeEp, a)}.`,
    ]),
    context('drive-impact', 'Strongest drive', strongestDrive ? [
      `Estimated net benefit: ${netBenefit(strongestDrive.actualHomeEp, a)}.`,
      `Expected net benefit for these opportunities: ${netBenefit(strongestDrive.expectedHomeEp, a)}.`,
    ] : ['No supported drive comparison is available.']),
  ];
  return { ...base, status: 'available', summary: `${verdict.label} (${verdict.rating}/5): ${verdict.summary}`, families,
    thresholds: [...OFFICIATING_THRESHOLDS].sort((x, y) => x.rating - y.rating).map(t => ({
      rating: t.rating, label: SUSPICION_SCALE[t.rating - 1].label, adjustedTailAtMost: t.tail,
    })), thresholdLabel: 'Calibrated rarity',
    combinationRule: 'The strongest game or drive signal is compared with the same search in earlier games. Signals are not added.',
    notes: [
      'Rarity uses (earlier games at least as unusual + 1) / (comparison games + 1). Each earlier game uses models trained before its season.',
      'The box score, spread and momentum are context only and do not raise this rating.',
      'Effects cover supported regulation penalty enforcement. They do not establish incorrect calls, missed fouls or a probability of manipulation.',
    ],
  };
}
