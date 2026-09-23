import twitterText from 'twitter-text';
import type { AnalysisResult, Game } from './contracts.js';
import { getGameVerdict } from './consumer-summary.js';
import type { EvidenceDraft } from './summaries.js';

export const SOCIAL_TEMPLATE_VERSION = 'game-final-screening-v1';
const conditions: Record<string, string> = {
  'Total offense below 200 yards': 'under 200 offensive yards',
  'At least 100 penalty yards': '100+ penalty yards',
  'Negative turnover margin': 'losing the turnover battle',
};
/** Original, deterministic prose derived from the same validated editorial rating as the report. */
export function renderSocialPost(game: Game, analysis: AnalysisResult, reportUrl: string, kind: 'initial' | 'correction' | 'update' = 'initial'): EvidenceDraft {
  const verdict = getGameVerdict(analysis.gameAudit);
  const rating = verdict.rating ? `${verdict.shortLabel} (${verdict.rating}/5)` : 'Unrated';
  const prefix = `${kind === 'initial' ? '' : kind === 'correction' ? 'Correction: ' : 'Update: '}${game.awayTeam} ${game.awayScore}–${game.homeScore} ${game.homeTeam} | Final. Game rating: ${rating}.`;
  let reason: string;
  let compact: string;
  let evidenceIds: string[] = [];
  const comparison = verdict.comparison;
  const historicalWins = comparison ? `${comparison.wins} ${comparison.wins === 1 ? 'win' : 'wins'}` : '';
  // Only the validated consumer verdict can authorize use of raw market arithmetic.
  const marketReason = verdict.reasons.find(reason => reason.startsWith('The final margin was ') && reason.includes('points from the recorded spread.'));
  const market = marketReason ? analysis.gameAudit?.market : undefined;
  const flag = comparison && verdict.rating !== null ? analysis.gameAudit?.flags.find(item => item.reference.wins === comparison.wins && item.reference.matchingGames === comparison.matchingGames && (item.status === 'historical_outlier' || item.status === 'unusual_profile')) : undefined;
  if (verdict.rating === 5 && verdict.cluster && comparison) {
    reason = `${historicalWins} in ${comparison.matchingGames} matching past performances, plus ${verdict.cluster.playIds.length} drive-extending penalties favored the winner.`;
    compact = `${comparison.wins}/${comparison.matchingGames} matching past performances won; ${verdict.cluster.playIds.length} penalties extended one winning-team drive.`;
    evidenceIds = [...(flag ? [flag.id] : []), ...(analysis.gameAudit?.reviewCandidates.filter(candidate => verdict.cluster!.playIds.includes(candidate.playId)).map(candidate => candidate.id) ?? [])];
  } else if (flag && comparison && (flag.status === 'historical_outlier' || !verdict.cluster || verdict.cluster.playIds.length < 3)) {
    reason = `${flag.team} won despite ${flag.conditions.map(condition => conditions[condition]).join(' and ')}. Past matches: ${historicalWins} in ${comparison.matchingGames} games.`;
    compact = `${flag.team}'s winning stat pattern had ${historicalWins} in ${comparison.matchingGames} matching past games.`;
    evidenceIds = [flag.id];
  } else if (verdict.cluster) {
    reason = `${verdict.cluster.playIds.length} defensive penalties extended one ${verdict.cluster.team} drive on third or fourth down.`;
    compact = reason;
    evidenceIds = analysis.gameAudit?.reviewCandidates.filter(candidate => verdict.cluster!.playIds.includes(candidate.playId)).map(candidate => candidate.id) ?? [];
  } else if (market && verdict.rating !== null && market.expectedHomeMargin !== null && market.actualHomeMargin !== null) {
    const line = market.expectedHomeMargin === 0 ? 'pick’em' : `${market.expectedHomeMargin > 0 ? market.homeTeam : market.awayTeam} -${Math.abs(market.expectedHomeMargin)}`;
    const final = market.actualHomeMargin === 0 ? 'tied' : `${market.actualHomeMargin > 0 ? market.homeTeam : market.awayTeam} won by ${Math.abs(market.actualHomeMargin)}`;
    reason = `Recorded line: ${line}; ${final}. ${market.absoluteError} points off; ${market.reference.atLeastAsSurprising}/${market.reference.games} prior games were at least this far off.`;
    compact = reason;
    // Stable evidence path to analysis.gameAudit.market; the object contains its source snapshot/checksum.
    evidenceIds = [`market:${game.id}:spread_line`];
  } else if (verdict.rating === 2) {
    reason = `${verdict.reviewCount} ${verdict.reviewCount === 1 ? 'play needs' : 'plays need'} a closer look; no stronger pattern met the checks.`;
    compact = reason;
    evidenceIds = analysis.gameAudit?.reviewCandidates.map(candidate => candidate.id) ?? [];
  } else if (verdict.rating === 1) {
    reason = 'No unusual winning profile or key review plays were found within the available checks.';
    compact = 'No unusual winning profile or key review plays found in the available checks.';
  } else {
    reason = 'The report is ready, but evidence is too limited to rate this result.';
    compact = reason;
  }
  const suffix = reportUrl;
  const attempts = [`${prefix} ${reason} ${suffix}`, `${prefix} ${compact} ${suffix}`];
  const text = attempts.find(candidate => twitterText.parseTweet(candidate).valid) ?? attempts[1];
  const parsed = twitterText.parseTweet(text);
  return { text, evidenceIds: [...new Set(evidenceIds)], weightedLength: parsed.weightedLength, valid: parsed.valid && game.homeScore !== null && game.awayScore !== null };
}
export function validateSocialPost(text: string, canonical: EvidenceDraft): boolean {
  return canonical.valid && text === canonical.text && twitterText.parseTweet(text).valid;
}
