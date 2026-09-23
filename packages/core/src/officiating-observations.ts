import type { Game } from './contracts.js';
import type { ProviderRow } from './normalize.js';

/** Extraction only: no fitted coefficients, rating thresholds, IO, or call-correctness inference. */
export const OFFICIATING_OBSERVATION_VERSION = 1 as const;
export type PenaltyFamily = 'offensive_hold' | 'defensive_pass' | 'offensive_presnap' | 'defensive_presnap' | 'personal_foul' | 'other_offense' | 'other_defense';
export type OfficiatingPlayKind = 'pass' | 'run' | 'unknown';
export type NextScoreLabel = -7 | -3 | -2 | 0 | 2 | 3 | 7;

export interface OfficiatingState {
  possessionTeam: string;
  defenseTeam: string;
  quarter: number;
  down: number;
  yardsToGo: number | null;
  yardline100: number | null;
  halfSecondsRemaining: number | null;
  gameSecondsRemaining: number | null;
  scoreDifference: number | null;
  possessionTimeouts: number | null;
  defenseTimeouts: number | null;
  receivesSecondHalfKickoff: number | null;
}

export interface ObservedPenalty {
  team: string;
  type: string;
  family: PenaltyFamily;
  yards: number | null;
  firstDownExtension: boolean;
  actualState: OfficiatingState | null;
  alternativeState: OfficiatingState | null;
  valuationReason: string | null;
  assumption: string | null;
}

export interface OfficiatingOpportunity {
  playId: string;
  order: number;
  driveId: string | null;
  state: OfficiatingState;
  playKind: OfficiatingPlayKind;
  penaltyStatus: 'none' | 'accepted' | 'excluded';
  penalty: ObservedPenalty | null;
  penaltyExclusionReason: string | null;
  /** Observed whole-play movement, signed for home; never a penalty's causal impact. */
  observedHomeWpChange: number | null;
  /** Future outcomes are deliberately isolated from all preplay features. */
  labels: { nextScore: NextScoreLabel | null; homeWin: 0 | 0.5 | 1 | null };
}

export interface OfficiatingGameObservation {
  schemaVersion: typeof OFFICIATING_OBSERVATION_VERSION;
  gameId: string;
  season: number;
  week: number;
  gameType: string;
  homeTeam: string;
  awayTeam: string;
  opportunities: OfficiatingOpportunity[];
  coverage: {
    inputRows: number;
    uniqueRows: number;
    duplicateRows: number;
    conflictingPlayIds: number;
    excludedRows: Record<string, number>;
    regulationOpportunities: number;
    overtimeOpportunities: number;
    unknownPlayKind: number;
    incompleteStates: number;
    acceptedPenalties: number;
    excludedPenalties: number;
    valuedStatePairs: number;
    valuationExclusions: Record<string, number>;
    nextScoreLabels: number;
    missingNextScoreLabels: number;
  };
}

const num = (v: unknown): number | null => v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v);
const str = (v: unknown): string => v === null || v === undefined ? '' : String(v).trim();
const yes = (v: unknown): boolean => v === true || v === 1 || v === '1';
const count = (counts: Record<string, number>, reason: string): void => { counts[reason] = (counts[reason] ?? 0) + 1; };
const inRange = (v: number | null, min: number, max: number): number | null => v !== null && v >= min && v <= max ? v : null;
const integer = (v: number | null, min: number, max: number): number | null => v !== null && Number.isInteger(v) ? inRange(v, min, max) : null;
const other = (game: Game, team: string): string => team === game.homeTeam ? game.awayTeam : game.homeTeam;
const half = (q: unknown): number | null => { const n = num(q); return n !== null && n >= 1 && n <= 4 ? (n <= 2 ? 1 : 2) : null; };

/** Some stadium feeds annotate GAME or omit it; observed opening-state evidence
 * can establish completeness without manufacturing a marker or score row.
 */
export function hasVerifiedGameOpening(rows: ProviderRow[]): boolean {
  const first = rows[0];
  if (!first) return false;
  if (str(first.desc) === 'GAME' && num(first.total_home_score) === 0 && num(first.total_away_score) === 0) return true;
  const firstActionIndex = rows.findIndex(p => ['kickoff', 'run', 'pass', 'punt', 'field_goal', 'extra_point', 'qb_spike', 'qb_kneel'].includes(str(p.play_type)) || ['kickoff_attempt', 'rush_attempt', 'pass_attempt'].some(key => yes(p[key])));
  if (firstActionIndex < 0) return false;
  const kickoff = rows[firstActionIndex];
  return yes(kickoff.kickoff_attempt) && num(kickoff.qtr) === 1 && num(kickoff.game_seconds_remaining) === 3600
    && num(kickoff.posteam_score) === 0 && num(kickoff.defteam_score) === 0
    && rows.slice(0, firstActionIndex).every(p => (num(p.qtr) === null || num(p.qtr) === 1) && num(p.total_home_score) === 0 && num(p.total_away_score) === 0);
}

function stateFromRow(game: Game, p: ProviderRow): OfficiatingState | null {
  const possessionTeam = str(p.posteam), defenseTeam = str(p.defteam);
  const quarter = integer(num(p.qtr), 1, 20), down = integer(num(p.down), 1, 4);
  if (![game.homeTeam, game.awayTeam].includes(possessionTeam) || defenseTeam !== other(game, possessionTeam) || quarter === null || down === null) return null;
  const suppliedReceive = integer(num(p.receive_2h_ko), 0, 1), opening = integer(num(p.home_opening_kickoff), 0, 1);
  const receivesSecondHalfKickoff = quarter > 2 ? 0 : suppliedReceive ?? (opening === null ? null : Number((possessionTeam === game.homeTeam && opening === 0) || (possessionTeam === game.awayTeam && opening === 1)));
  const possessionScore = num(p.posteam_score), defenseScore = num(p.defteam_score);
  return {
    possessionTeam, defenseTeam, quarter, down,
    yardsToGo: inRange(num(p.ydstogo), 0, 100), yardline100: inRange(num(p.yardline_100), 0, 100),
    halfSecondsRemaining: inRange(num(p.half_seconds_remaining), 0, 1800),
    gameSecondsRemaining: inRange(num(p.game_seconds_remaining), 0, 3600),
    scoreDifference: num(p.score_differential) ?? (possessionScore !== null && defenseScore !== null ? possessionScore - defenseScore : null),
    possessionTimeouts: integer(num(p.posteam_timeouts_remaining), 0, 3),
    defenseTimeouts: integer(num(p.defteam_timeouts_remaining), 0, 3), receivesSecondHalfKickoff,
  };
}

/** Same conservative nonterminal regulation domain as analytics/R/states.R. */
export function officiatingStateReason(s: OfficiatingState): string | null {
  if (s.quarter > 4) return 'unsupported_overtime';
  if ([s.yardsToGo, s.yardline100, s.halfSecondsRemaining, s.gameSecondsRemaining, s.scoreDifference, s.possessionTimeouts, s.defenseTimeouts, s.receivesSecondHalfKickoff].some(v => v === null)) return 'missing_state_fields';
  if (s.halfSecondsRemaining! <= 0 || s.gameSecondsRemaining! <= 0) return 'terminal_or_halftime';
  if (s.yardsToGo! <= 0 || s.yardsToGo! > 99 || s.yardline100! <= 0 || s.yardline100! >= 100) return 'unsupported_state_domain';
  return null;
}

function playKind(p: ProviderRow): OfficiatingPlayKind {
  // The corrected provider classification takes precedence over narrative from a replay.
  if (yes(p.qb_dropback) || yes(p.sack) || str(p.play_type) === 'pass') return 'pass';
  if (str(p.play_type) === 'run') return 'run';
  if (str(p.play_type) !== 'no_play') return 'unknown';
  const base = str(p.desc).split(/\bPENALTY\b/i)[0];
  if (/\b(?:reversed|reversal)\b/i.test(base)) return 'unknown';
  if (/\bpass (?:incomplete|complete|short|deep)|\bsacked\b|\bscrambl(?:e|es|ed)\b/i.test(base)) return 'pass';
  if (/\b(?:left|right) (?:end|tackle|guard)\b|\bup the middle\b|\bkneels\b/i.test(base)) return 'run';
  return 'unknown';
}

function specialTeamsNoPlay(p: ProviderRow): boolean {
  if (str(p.play_type) !== 'no_play') return false;
  // nflverse can clear attempt flags when enforcement nullifies a kick. Those
  // rows are not scrimmage exposures just because their down remains populated.
  if (/^(?:Roughing the (?:Kicker|Punter)|Running Into the Kicker|Kick Catch Interference|Fair Catch Interference|Kickoff Out of Bounds)$/i.test(str(p.penalty_type))) return true;
  const base = str(p.desc).split(/\bPENALTY\b/i)[0];
  if (yes(p.qb_dropback) || yes(p.pass_attempt) || yes(p.rush_attempt)) return false;
  return /\bpunts? \d+ yards?\b|\bkicks? \d+ yards?\b|\bfield goal (?:is|attempt)\b|\b(?:punt|field goal|kickoff) formation\b/i.test(base);
}

function familyFor(type: string, offense: boolean): PenaltyFamily {
  if (offense && /^(?:Offensive )?Holding$/i.test(type)) return 'offensive_hold';
  if (!offense && /^(?:Defensive Holding|Defensive Pass Interference|Illegal Contact|Pass Interference)$/i.test(type)) return 'defensive_pass';
  if (offense && /^(?:False Start|Delay of Game|Offensive Offside|Illegal Formation|Illegal Shift|Illegal Motion|Too Many Men on Field|Too Many Men in Huddle)$/i.test(type)) return 'offensive_presnap';
  if (!offense && /^(?:Encroachment|Neutral Zone Infraction|Defensive Offside|Offside|(?:Defensive )?Too Many Men on Field)$/i.test(type)) return 'defensive_presnap';
  if (/roughing|unnecessary roughness|personal foul|face ?mask|horse collar|unsportsmanlike|taunting|tripping|illegal use of hands/i.test(type)) return 'personal_foul';
  return offense ? 'other_offense' : 'other_defense';
}

function extractPenalty(p: ProviderRow, s: OfficiatingState): { status: OfficiatingOpportunity['penaltyStatus']; penalty: ObservedPenalty | null; reason: string | null } {
  const description = str(p.desc), mentions = description.match(/\bPENALTY\b/gi)?.length ?? 0;
  const hasRecord = yes(p.penalty) || mentions > 0 || !!str(p.penalty_type) || !!str(p.penalty_team);
  if (!hasRecord) return { status: 'none', penalty: null, reason: null };
  const reject = (reason: string) => ({ status: 'excluded' as const, penalty: null, reason });
  if (/\bdeclined\b|\boffset(?:ting)?\b|\bno penalty\b|\bpicked up\b/i.test(description)) return reject('declined_offsetting_or_removed');
  if (mentions > 1 || /\bmultiple\b/i.test(str(p.penalty_type))) return reject('multiple_penalties');
  if (!yes(p.penalty)) return reject('unconfirmed_accepted_penalty');
  const team = str(p.penalty_team), type = str(p.penalty_type);
  if (![s.possessionTeam, s.defenseTeam].includes(team) || !type || /unknown|unspecified/i.test(type)) return reject('missing_penalty_identity');
  // A parsed clause must agree with the provider's final penalty identity.
  const clauseTeam = description.match(/\bPENALTY(?: on)? ([A-Z]{2,3})[- ,]/i)?.[1];
  if (clauseTeam && clauseTeam !== team) return reject('penalty_identity_conflict');
  const clauseType = description.match(/\bPENALTY(?: on)? [^,]+, ([^,]+),/i)?.[1]?.trim();
  if (clauseType && clauseType.toLowerCase() !== type.toLowerCase()) return reject('penalty_identity_conflict');
  const offense = team === s.possessionTeam;
  return { status: 'accepted', reason: null, penalty: {
    team, type, family: familyFor(type, offense), yards: inRange(num(p.penalty_yards), 0, 100),
    firstDownExtension: !offense && s.down >= 3 && yes(p.first_down_penalty) && !yes(p.first_down_pass) && !yes(p.first_down_rush),
    actualState: null, alternativeState: null, valuationReason: null, assumption: null,
  } };
}

function flipState(s: OfficiatingState): OfficiatingState {
  return { ...s, possessionTeam: s.defenseTeam, defenseTeam: s.possessionTeam,
    scoreDifference: -s.scoreDifference!, yardline100: 100 - s.yardline100!, down: 1, yardsToGo: Math.min(10, 100 - s.yardline100!),
    possessionTimeouts: s.defenseTimeouts, defenseTimeouts: s.possessionTimeouts,
    receivesSecondHalfKickoff: s.quarter <= 2 ? 1 - s.receivesSecondHalfKickoff! : 0 };
}

function reconstructPenalty(game: Game, p: ProviderRow, next: ProviderRow | undefined, pre: OfficiatingState, penalty: ObservedPenalty): void {
  const fail = (reason: string): void => { penalty.valuationReason = reason; };
  const preReason = officiatingStateReason(pre);
  if (preReason) return fail(preReason);
  if ((str(p.desc).match(/\bPENALTY\b/gi)?.length ?? 0) !== 1) return fail('unparsed_penalty_clause');
  if (!next) return fail('missing_post_ruling_state');
  const post = stateFromRow(game, next);
  if (!post || officiatingStateReason(post)) return fail('unsupported_post_ruling_state');
  if (pre.quarter !== post.quarter || pre.halfSecondsRemaining! <= 120 || post.halfSecondsRemaining! > pre.halfSecondsRemaining! || post.gameSecondsRemaining! > pre.gameSecondsRemaining!) return fail('clock_or_period_ambiguity');
  if (yes(p.replay_or_challenge) || /^(?:reversed|upheld)$/i.test(str(p.replay_or_challenge_result)) || /\b(?:reversed|ruling was)\b/i.test(str(p.desc)) || ['touchdown', 'interception', 'fumble', 'safety', 'field_goal_attempt'].some(key => yes(p[key]))) return fail('scoring_turnover_or_replay');
  if (pre.possessionTeam !== post.possessionTeam || pre.scoreDifference !== post.scoreDifference || pre.possessionTimeouts !== post.possessionTimeouts || pre.defenseTimeouts !== post.defenseTimeouts) return fail('intervening_state_change');
  const offense = penalty.team === pre.possessionTeam, yards = penalty.yards;
  if (['False Start', 'Delay of Game', 'Encroachment', 'Neutral Zone Infraction'].includes(penalty.type) && p.play_type === 'no_play') {
    const expectedYardline = pre.yardline100! + (offense ? yards ?? 0 : -(yards ?? 0));
    if (yards === null || yards <= 0 || Math.abs(post.yardline100! - expectedYardline) > .51) return fail('enforcement_geometry_mismatch');
    const awarded = !offense && yards >= pre.yardsToGo!;
    const expectedDown = awarded ? 1 : pre.down;
    const expectedDistance = awarded ? Math.min(10, expectedYardline) : pre.yardsToGo! + (offense ? yards : -yards);
    if (post.down !== expectedDown || Math.abs(post.yardsToGo! - expectedDistance) > .51) return fail('enforcement_down_mismatch');
    penalty.actualState = { ...post, halfSecondsRemaining: pre.halfSecondsRemaining, gameSecondsRemaining: pre.gameSecondsRemaining };
    penalty.alternativeState = { ...pre };
    penalty.assumption = 'Same-clock state without presnap enforcement; the foul is not classified as incorrect.';
    return;
  }
  const base = str(p.desc).split(/\bPENALTY\b/i)[0];
  if (['Defensive Holding', 'Illegal Contact', 'Defensive Pass Interference', 'Roughing the Passer'].includes(penalty.type) && !offense && /\bpass incomplete\b/i.test(base) && yes(p.first_down_penalty) && !yes(p.first_down_pass) && !yes(p.first_down_rush) && post.down === 1) {
    if (yards === null || yards <= 0 || Math.abs(post.yardline100! - (pre.yardline100! - yards)) > .51 || Math.abs(post.yardsToGo! - Math.min(10, post.yardline100!)) > .51) return fail('enforcement_geometry_mismatch');
    let alternative = { ...pre, halfSecondsRemaining: post.halfSecondsRemaining, gameSecondsRemaining: post.gameSecondsRemaining };
    alternative = pre.down === 4 ? flipState(alternative) : { ...alternative, down: pre.down + 1 };
    penalty.actualState = { ...post }; penalty.alternativeState = alternative;
    penalty.assumption = 'The observed incomplete pass stands without enforcement; this does not estimate a foul-free play.';
    return;
  }
  fail('alternative_not_identifiable');
}

function observedMovement(game: Game, p: ProviderRow, s: OfficiatingState): number | null {
  if (s.quarter > 4) return null;
  const before = inRange(num(p.home_wp), 0, 1), after = inRange(num(p.home_wp_post), 0, 1);
  if (before !== null && after !== null) return after - before;
  const wpa = inRange(num(p.wpa), -1, 1);
  return wpa === null ? null : wpa * (s.possessionTeam === game.homeTeam ? 1 : -1);
}

/** A score label represents the next scoring event in this half (TD=7), not actual drive points. */
function scoreLabels(game: Game, rows: ProviderRow[], contaminated: boolean): Map<ProviderRow, NextScoreLabel | null> {
  const labels = new Map<ProviderRow, NextScoreLabel | null>();
  if (contaminated || game.gameType !== 'REG') return labels;
  const verifiedOpening = hasVerifiedGameOpening(rows);
  for (const h of [1, 2]) {
    const indices = rows.map((p, i) => half(p.qtr) === h ? i : -1).filter(i => i >= 0);
    if (!indices.length) continue;
    const last = rows[indices.at(-1)!];
    const hasEnd = (num(last.qtr) === h * 2 && num(last.half_seconds_remaining) === 0) || (h === 1 && rows.some(p => num(p.qtr) === 3)) || (h === 2 && rows.some(p => /\bEND GAME\b/i.test(str(p.desc)) || num(p.qtr)! > 4));
    if (!hasEnd) continue; // A truncated feed must not be labeled "no next score".
    const events = new Map<number, { team: string; points: 7 | 3 | 2 }>();
    let valid = true;
    for (const i of indices) {
      const p = rows[i], previous = rows[i - 1];
      const home = num(p.total_home_score), away = num(p.total_away_score);
      const prevHome = previous ? num(previous.total_home_score) : verifiedOpening ? 0 : null;
      const prevAway = previous ? num(previous.total_away_score) : verifiedOpening ? 0 : null;
      if ([home, away, prevHome, prevAway].some(v => v === null || v < 0)) { valid = false; break; }
      const dh = home! - prevHome!, da = away! - prevAway!;
      if (dh < 0 || da < 0 || (dh > 0 && da > 0)) { valid = false; break; }
      const delta = Math.max(dh, da);
      if (!delta) continue;
      if (yes(p.extra_point_attempt) || yes(p.two_point_attempt) || yes(p.defensive_extra_point_attempt) || yes(p.defensive_two_point_attempt)) {
        if (delta > 2) valid = false;
        continue;
      }
      // Deliberately use scoreboard differences, not outcome tags or provider EP labels.
      const points = delta === 6 ? 7 : delta === 3 ? 3 : delta === 2 ? 2 : null;
      if (points === null) { valid = false; break; }
      events.set(i, { team: dh > 0 ? game.homeTeam : game.awayTeam, points });
    }
    if (!valid) continue;
    let nextEvent: { team: string; points: 7 | 3 | 2 } | null = null;
    for (let n = indices.length - 1; n >= 0; n--) {
      const i = indices[n], p = rows[i];
      nextEvent = events.get(i) ?? nextEvent;
      labels.set(p, nextEvent ? (nextEvent.team === p.posteam ? nextEvent.points : -nextEvent.points) as NextScoreLabel : 0);
    }
  }
  return labels;
}

function finalSnapshotValid(game: Game, rows: ProviderRow[]): boolean {
  const final = rows.at(-1);
  return !!final && hasVerifiedGameOpening(rows) && /^END GAME(?:\s|$)/.test(str(final.desc))
    && [1, 2, 3, 4].every(q => rows.some(p => num(p.qtr) === q))
    && num(final.qtr)! >= 4 && game.homeScore !== null && game.awayScore !== null
    && num(final.total_home_score) === game.homeScore && num(final.total_away_score) === game.awayScore;
}

export function extractOfficiatingObservation(game: Game, input: ProviderRow[]): OfficiatingGameObservation {
  const coverage: OfficiatingGameObservation['coverage'] = {
    inputRows: input.length, uniqueRows: 0, duplicateRows: 0, conflictingPlayIds: 0, excludedRows: {},
    regulationOpportunities: 0, overtimeOpportunities: 0, unknownPlayKind: 0, incompleteStates: 0,
    acceptedPenalties: 0, excludedPenalties: 0, valuedStatePairs: 0, valuationExclusions: {}, nextScoreLabels: 0, missingNextScoreLabels: 0,
  };
  const unique = new Map<string, { row: ProviderRow; originalIndex: number; identity: string }>(), conflicts = new Set<string>();
  for (const [originalIndex, row] of input.entries()) {
    const id = str(row.play_id);
    if (!id) { count(coverage.excludedRows, 'missing_play_id'); continue; }
    if ((row.game_id != null && str(row.game_id) !== game.id) || (row.home_team != null && str(row.home_team) !== game.homeTeam) || (row.away_team != null && str(row.away_team) !== game.awayTeam) || (row.season != null && num(row.season) !== game.season)) { count(coverage.excludedRows, 'game_identity_conflict'); continue; }
    if (yes(row.play_deleted)) { count(coverage.excludedRows, 'deleted_play'); continue; }
    const identity = JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'source_order').sort(([a], [b]) => a.localeCompare(b))));
    const previous = unique.get(id);
    if (previous) {
      if (previous.identity === identity) coverage.duplicateRows++;
      else conflicts.add(id);
    } else unique.set(id, { row, originalIndex, identity });
  }
  coverage.conflictingPlayIds = conflicts.size;
  if (conflicts.size) coverage.excludedRows.conflicting_play = conflicts.size;
  const allEntries = [...unique.values()];
  // IDs and clocks are not reliable chronology around replay corrections. Use provider order.
  const orderField = ['order_sequence', 'source_order'].find(field => allEntries.every(({ row }) => num(row[field]) !== null) && new Set(allEntries.map(({ row }) => num(row[field]))).size === allEntries.length);
  if (orderField) allEntries.sort((a, b) => num(a.row[orderField])! - num(b.row[orderField])!);
  const entries = allEntries.filter(({ row }) => !conflicts.has(str(row.play_id)));
  const rows = entries.map(entry => entry.row);
  const nextRows = new Map<string, ProviderRow>();
  for (let i = 0; i + 1 < allEntries.length; i++) {
    const current = allEntries[i].row, next = allEntries[i + 1].row;
    // Removing a conflicted row must not make a later state look immediately adjacent.
    if (!conflicts.has(str(current.play_id)) && !conflicts.has(str(next.play_id)) && !coverage.excludedRows.missing_play_id) nextRows.set(str(current.play_id), next);
  }
  coverage.uniqueRows = rows.length;
  const contaminated = conflicts.size > 0 || !!coverage.excludedRows.missing_play_id;
  const finalValid = finalSnapshotValid(game, rows);
  const nextScores = scoreLabels(game, rows, contaminated || !finalValid);
  const allRegulationScoresValid = rows.filter(p => half(p.qtr) !== null).every(p => nextScores.has(p));
  const homeWin = game.gameType === 'REG' && finalValid && allRegulationScoresValid && !contaminated ? (game.homeScore === game.awayScore ? .5 : game.homeScore! > game.awayScore! ? 1 : 0) : null;
  const opportunities: OfficiatingOpportunity[] = [];
  for (let order = 0; order < rows.length; order++) {
    const p = rows[order], type = str(p.play_type);
    if (specialTeamsNoPlay(p)) { count(coverage.excludedRows, 'special_teams_no_play'); continue; }
    if (['kickoff', 'punt', 'field_goal', 'extra_point', 'qb_kneel', 'qb_spike'].includes(type) || ['kickoff_attempt', 'punt_attempt', 'field_goal_attempt', 'extra_point_attempt', 'two_point_attempt', 'special_teams_play', 'qb_kneel', 'qb_spike'].some(key => yes(p[key]))) { count(coverage.excludedRows, 'non_scrimmage_or_clock_play'); continue; }
    if (!['pass', 'run', 'no_play'].includes(type) && !yes(p.qb_dropback) && !yes(p.rush_attempt)) { count(coverage.excludedRows, 'non_scrimmage'); continue; }
    if (type === 'no_play' && !yes(p.penalty) && !/\bPENALTY\b/i.test(str(p.desc))) { count(coverage.excludedRows, 'non_penalty_no_play'); continue; }
    const state = stateFromRow(game, p);
    if (!state) { count(coverage.excludedRows, 'missing_opportunity_identity'); continue; }
    const parsed = extractPenalty(p, state), kind = playKind(p);
    if (kind === 'unknown') coverage.unknownPlayKind++;
    if (state.quarter <= 4) { coverage.regulationOpportunities++; if (officiatingStateReason(state)) coverage.incompleteStates++; }
    else coverage.overtimeOpportunities++;
    if (parsed.penalty) {
      coverage.acceptedPenalties++;
      reconstructPenalty(game, p, nextRows.get(str(p.play_id)), state, parsed.penalty);
      if (parsed.penalty.actualState) coverage.valuedStatePairs++;
      else count(coverage.valuationExclusions, parsed.penalty.valuationReason ?? 'unknown');
    } else if (parsed.status === 'excluded') coverage.excludedPenalties++;
    const driveField = p.fixed_drive != null ? 'fixed_drive' : 'drive';
    const drive = integer(num(p[driveField]), 1, 1000);
    const nextScore = state.quarter <= 4 ? nextScores.get(p) ?? null : null;
    if (nextScore === null) coverage.missingNextScoreLabels++; else coverage.nextScoreLabels++;
    opportunities.push({ playId: str(p.play_id), order, driveId: drive === null ? null : `${driveField}:${drive}:${state.possessionTeam}`,
      state, playKind: kind, penaltyStatus: parsed.status, penalty: parsed.penalty, penaltyExclusionReason: parsed.reason,
      observedHomeWpChange: observedMovement(game, p, state), labels: { nextScore, homeWin: state.quarter <= 4 ? homeWin : null } });
  }
  return { schemaVersion: OFFICIATING_OBSERVATION_VERSION, gameId: game.id, season: game.season, week: game.week, gameType: game.gameType, homeTeam: game.homeTeam, awayTeam: game.awayTeam, opportunities, coverage };
}
