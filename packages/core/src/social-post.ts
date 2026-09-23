import twitterText from 'twitter-text';
import type { AnalysisResult, Game } from './contracts.js';
import { getGameVerdict } from './consumer-summary.js';
import type { EvidenceDraft } from './summaries.js';

export const SOCIAL_TEMPLATE_VERSION = 'game-final-screening-v2';
const headings = {1:'🟢 FAIR — 1/5',2:'🟡 DEBATABLE — 2/5',3:'🟠 HMM — 3/5',4:'🔴 SUS — 4/5',5:'🚨🚨 RIGGED? 🚨🚨'} as const;
const conditions: Record<string, string> = {
  'Total offense below 200 yards': 'under 200 offensive yards',
  'At least 100 penalty yards': '100+ penalty yards',
  'Negative turnover margin': 'losing the turnover battle',
};
/** Original, deterministic prose derived from the same validated editorial rating as the report. */
export function renderSocialPost(game: Game, analysis: AnalysisResult, reportUrl: string, kind: 'initial' | 'correction' | 'update' = 'initial'): EvidenceDraft {
  const verdict = getGameVerdict(analysis.gameAudit);
  const heading = verdict.rating ? headings[verdict.rating] : '⚪ UNRATED';
  const prefix = `${kind === 'initial' ? '' : kind === 'correction' ? 'Correction: ' : 'Update: '}${heading}\n${game.awayTeam} ${game.awayScore} — ${game.homeTeam} ${game.homeScore}`;
  const suffix = `\n\nSee the Review: ${reportUrl}\n\n#NFL #UnderReview`;
  let findings: string[] = [];
  let evidenceIds: string[] = [];
  const comparison = verdict.comparison;
  const historicalWins = comparison ? `${comparison.wins} ${comparison.wins === 1 ? 'win' : 'wins'}` : '';
  // Only the validated consumer verdict can authorize use of raw market arithmetic.
  const marketReason = verdict.reasons.find(reason => reason.startsWith('The final margin was ') && reason.includes('points from the recorded spread.'));
  const market = marketReason ? analysis.gameAudit?.market : undefined;
  const flag = comparison && verdict.rating !== null ? analysis.gameAudit?.flags.find(item => item.reference.wins === comparison.wins && item.reference.matchingGames === comparison.matchingGames && (item.status === 'historical_outlier' || item.status === 'unusual_profile')) : undefined;
  if (verdict.rating === 5 && verdict.cluster && comparison) {
    findings = [
      `${historicalWins} in ${comparison.matchingGames} matching past games; ${verdict.cluster.playIds.length} penalties extended one ${verdict.cluster.team} drive.`,
      `${comparison.wins}/${comparison.matchingGames} past matches won; ${verdict.cluster.playIds.length} penalties extended one ${verdict.cluster.team} drive.`,
      `${comparison.wins}/${comparison.matchingGames} past matches won; ${verdict.cluster.playIds.length} first-down penalties on one ${verdict.cluster.team} drive.`,
    ];
    evidenceIds = [...(flag ? [flag.id] : []), ...(analysis.gameAudit?.reviewCandidates.filter(candidate => verdict.cluster!.playIds.includes(candidate.playId)).map(candidate => candidate.id) ?? [])];
  } else if (flag && comparison && (flag.status === 'historical_outlier' || !verdict.cluster || verdict.cluster.playIds.length < 3)) {
    findings = [
      `${flag.team} won despite ${flag.conditions.map(condition => conditions[condition]).join(' and ')}. Past matches: ${historicalWins} in ${comparison.matchingGames} games.`,
      `${flag.team}'s winning stat pattern had ${historicalWins} in ${comparison.matchingGames} matching past games.`,
    ];
    evidenceIds = [flag.id];
  } else if (verdict.cluster) {
    findings = [`${verdict.cluster.playIds.length} defensive penalties extended one ${verdict.cluster.team} drive on third or fourth down.`];
    evidenceIds = analysis.gameAudit?.reviewCandidates.filter(candidate => verdict.cluster!.playIds.includes(candidate.playId)).map(candidate => candidate.id) ?? [];
  } else if (market && verdict.rating !== null && market.expectedHomeMargin !== null && market.actualHomeMargin !== null) {
    const line = market.expectedHomeMargin === 0 ? 'pick’em' : `${market.expectedHomeMargin > 0 ? market.homeTeam : market.awayTeam} -${Math.abs(market.expectedHomeMargin)}`;
    const final = market.actualHomeMargin === 0 ? 'tied' : `${market.actualHomeMargin > 0 ? market.homeTeam : market.awayTeam} won by ${Math.abs(market.actualHomeMargin)}`;
    findings = [
      `Recorded line: ${line}; ${final}. ${market.absoluteError} points off; ${market.reference.atLeastAsSurprising}/${market.reference.games} prior games were at least this far off.`,
      `Line: ${line}; ${final} (${market.absoluteError} points off). ${market.reference.atLeastAsSurprising}/${market.reference.games} prior games were this far off or more.`,
    ];
    // Stable evidence path to analysis.gameAudit.market; the object contains its source snapshot/checksum.
    evidenceIds = [`market:${game.id}:spread_line`];
  }
  let bodies: string[];
  if (verdict.rating === 1) {
    bodies = ['Nothing unusual surfaced in our automated checks. No qualifying statistical flags or key review candidates.'];
  } else if (verdict.rating === 2 && verdict.reviewCount > 0) {
    bodies = [`👀 ${verdict.reviewCount} ${verdict.reviewCount === 1 ? 'play deserves' : 'plays deserve'} a closer look.`];
    evidenceIds = analysis.gameAudit?.reviewCandidates.map(candidate => candidate.id) ?? [];
  } else if (verdict.rating === 2 || verdict.rating === 3) {
    bodies = findings.map(finding => `📊 ${finding}`);
  } else if (verdict.rating === 4) {
    bodies = findings.map(finding => `Our system detected a strong fairness concern:\n⚠️ ${finding}`);
  } else if (verdict.rating === 5) {
    bodies = findings.map(finding => `A highly unusual statistical result AND a major penalty sequence favored the winner:\n⚠️ ${finding}`);
  } else {
    bodies = ['The report is ready, but evidence is too limited to rate this result.'];
  }
  const attempts = bodies.map(body => `${prefix}\n\n${body}${suffix}`);
  const text = attempts.find(candidate => twitterText.parseTweet(candidate).valid) ?? attempts.at(-1) ?? `${prefix}${suffix}`;
  const parsed = twitterText.parseTweet(text);
  return { text, evidenceIds: [...new Set(evidenceIds)], weightedLength: parsed.weightedLength, valid: bodies.length > 0 && parsed.valid && game.homeScore !== null && game.awayScore !== null };
}
export function validateSocialPost(text: string, canonical: EvidenceDraft): boolean {
  return canonical.valid && text === canonical.text && twitterText.parseTweet(text).valid;
}
