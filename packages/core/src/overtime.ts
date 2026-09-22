import { createHash } from 'node:crypto';
import type { Game } from './contracts.js';
import type { ProviderRow } from './normalize.js';

export const OVERTIME_MODEL_VERSION = 'under-review-overtime-empirical-v1';
export const OVERTIME_PARAMETERS = Object.freeze({ minimumGames: 20, maximumGames: 40, maximumDistance: 3, maximumClockDifference: 300, maximumFieldDifference: 35, maximumDownDifference: 1, dirichletPriorPerOutcome: 0.5 });
export type OvertimePhase = 'opening_possession_legacy' | 'opening_possession_both' | 'reply_to_field_goal' | 'reply_to_touchdown' | 'sudden_death' | 'try' | 'terminal' | 'unknown';
export type OvertimeOutcome = 'win' | 'loss' | 'tie';
export interface OvertimeState {
  playId: string; phase: OvertimePhase; reasonCode: string | null; posteam: string | null;
  clock: number | null; down: number | null; distance: number | null; yardline: number | null;
  scoreDifference: number | null; ownTimeouts: number | null; opponentTimeouts: number | null;
  observedOutcome?: 'home_win' | 'away_win' | 'tie';
}
export interface OvertimeReferenceState {
  gameId: string; season: number; playId: string; phase: OvertimePhase; clock: number; down: number;
  distance: number; yardline: number; scoreDifference: number; ownTimeouts: number; opponentTimeouts: number;
  outcome: OvertimeOutcome;
}
export interface OvertimeReference {
  schemaVersion: 1; modelVersion: string; startSeason: number; endSeason: number;
  parameters: typeof OVERTIME_PARAMETERS;
  sources: { season: number; url: string; checksum: string; license: string; rows: number; overtimeGames: number }[];
  rows: OvertimeReferenceState[]; notes: string[]; checksum: string;
}
export interface OvertimeTimelinePoint {
  playId: string; homeWp: number | null; awayWp: number | null; tieProbability: number | null;
  status: 'experimental' | 'unavailable' | 'observed'; reasonCode: string | null;
  modelVersion: string; supportGames: number; phase: OvertimePhase;
}
const number = (x: unknown): number | null => x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
const flag = (x: unknown): boolean => x === true || x === 1 || x === '1';
const text = (x: unknown): string => x === null || x === undefined ? '' : String(x);
const team = (x: unknown, game: Game): string | null => x === game.homeTeam || x === game.awayTeam ? String(x) : null;

/** All phase updates occur AFTER the current preplay state has been emitted.
 * Provider order is authoritative. Final scores and drive-end annotations are never predictors.
 * Deliberately supports only ordinary 10-minute regular-season overtime (2017 onward).
 */
export function buildOvertimeStates(game: Game, plays: ProviderRow[]): OvertimeState[] {
  const states: OvertimeState[] = [];
  let firstTeam: string | null = null;
  let activeTeam: string | null = null;
  let ended = false;
  let unknown: string | null = null;
  const completed = new Set<string>();
  let touchdownSeen = false;
  for (const p of plays) {
    const quarter = number(p.qtr);
    if (quarter === null || quarter <= 4) continue;
    const posteam = team(p.posteam, game);
    const clock = number(p.quarter_seconds_remaining);
    const scoreDifference = number(p.score_differential);
    const state: OvertimeState = { playId: text(p.play_id), phase: 'unknown', reasonCode: null, posteam,
      clock, down: number(p.down), distance: number(p.ydstogo), yardline: number(p.yardline_100), scoreDifference,
      ownTimeouts: number(p.posteam_timeouts_remaining), opponentTimeouts: number(p.defteam_timeouts_remaining) };
    const description = text(p.desc).trim();
    // This is an observed terminal result, not a prediction or a use of future schedule scores.
    if (description === 'END GAME') {
      const home = number(p.total_home_score), away = number(p.total_away_score);
      state.phase = 'terminal';
      if (home !== null && away !== null && home >= 0 && away >= 0) state.observedOutcome = home === away ? 'tie' : home > away ? 'home_win' : 'away_win';
      else state.reasonCode = 'terminal_score_missing';
      states.push(state); continue;
    }
    if (game.gameType !== 'REG') state.reasonCode = 'unsupported_postseason_overtime';
    else if (game.season < 2017 || quarter !== 5) state.reasonCode = 'unsupported_overtime_rule_era_or_period';
    else if (clock === null || clock < 0 || clock > 600) state.reasonCode = 'invalid_overtime_clock';
    else {
      // The opening kickoff establishes receipt, not the regulation opening-kickoff field.
      if (!firstTeam && flag(p.kickoff_attempt) && clock === 600 && posteam && scoreDifference === 0) {
        firstTeam = posteam; activeTeam = posteam;
      }
      if (posteam && activeTeam && posteam !== activeTeam) {
        if (ended) { completed.add(activeTeam); activeTeam = posteam; ended = false; }
        else unknown = 'ambiguous_overtime_possession_transition';
      }
      if (!firstTeam) state.reasonCode = 'missing_overtime_opening_possession';
      else if (unknown) state.reasonCode = unknown;
      else if (flag(p.extra_point_attempt) || flag(p.two_point_attempt)) { state.phase = 'try'; state.reasonCode = 'unsupported_overtime_try'; }
      else if (completed.size >= 2) state.phase = 'sudden_death';
      else if (!completed.has(firstTeam)) state.phase = game.season >= 2025 ? 'opening_possession_both' : 'opening_possession_legacy';
      else if (posteam && posteam !== firstTeam && scoreDifference === -3 && !touchdownSeen) state.phase = 'reply_to_field_goal';
      else if (posteam && posteam !== firstTeam && scoreDifference === 0 && !touchdownSeen) state.phase = 'sudden_death';
      else if (touchdownSeen) { state.phase = 'reply_to_touchdown'; state.reasonCode = 'unsupported_touchdown_response_phase'; }
      else state.reasonCode = 'ambiguous_overtime_scoring_phase';
      if (state.phase === 'sudden_death' && scoreDifference !== null && scoreDifference !== 0) state.reasonCode = 'non_tied_sudden_death_state';
      if (!state.reasonCode) {
        if (clock === 0) state.reasonCode = 'expired_clock_without_terminal_result';
        else if (!posteam || team(p.defteam, game) === posteam || !team(p.defteam, game)) state.reasonCode = 'missing_overtime_possession';
        else if (state.down === null) state.reasonCode = 'non_scrimmage_overtime_entry';
        else if (![1, 2, 3, 4].includes(state.down) || state.distance === null || state.distance < 1 || state.distance > 99 || state.yardline === null || state.yardline <= 0 || state.yardline >= 100 || scoreDifference === null || state.ownTimeouts === null || state.opponentTimeouts === null || ![0, 1, 2].includes(state.ownTimeouts) || ![0, 1, 2].includes(state.opponentTimeouts)) state.reasonCode = 'missing_or_invalid_overtime_state';
      }
    }
    states.push(state);
    // A nullified play does not consume an opportunity; try plays do not start a new possession.
    if (p.play_type === 'no_play' || flag(p.extra_point_attempt) || flag(p.two_point_attempt)) continue;
    // Only information observed by the NEXT entry is used below. Multiple possession plays,
    // onside/muffed kicks and safeties can change entitlement; withhold subsequent estimates.
    if (flag(p.own_kickoff_recovery) || flag(p.safety) || p.field_goal_result === 'blocked' || (flag(p.fumble) && (flag(p.kickoff_attempt) || flag(p.punt_attempt))) || (p.fumbled_2_team && text(p.fumbled_2_team))) unknown = 'unsupported_overtime_possession_exception';
    if (flag(p.touchdown)) touchdownSeen = true;
    const turnoverOnDowns = state.down === 4 && !flag(p.penalty) && !flag(p.first_down) && !flag(p.first_down_rush) && !flag(p.first_down_pass) && (p.play_type === 'run' || p.play_type === 'pass') && number(p.yards_gained) !== null && state.distance !== null && number(p.yards_gained)! < state.distance;
    if (flag(p.punt_attempt) || flag(p.interception) || flag(p.fumble_lost) || flag(p.touchdown) || flag(p.safety) || flag(p.field_goal_attempt) || turnoverOnDowns) ended = true;
  }
  return states;
}

export function overtimeReferenceChecksum(reference: Omit<OvertimeReference, 'checksum'> | OvertimeReference): string {
  const { checksum: _checksum, ...payload } = reference as OvertimeReference;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function validOvertimeReference(reference: OvertimeReference): boolean {
  return reference?.schemaVersion === 1 && reference.modelVersion === OVERTIME_MODEL_VERSION && reference.endSeason <= 2025 && reference.startSeason >= 2017 && JSON.stringify(reference.parameters) === JSON.stringify(OVERTIME_PARAMETERS) && reference.checksum === overtimeReferenceChecksum(reference);
}
function comparableDistance(state: OvertimeState, row: OvertimeReferenceState): number {
  if (state.phase !== row.phase || state.scoreDifference !== row.scoreDifference || state.clock === null || state.down === null || state.yardline === null || state.distance === null || state.ownTimeouts === null || state.opponentTimeouts === null) return Infinity;
  const clock = Math.abs(state.clock - row.clock), field = Math.abs(state.yardline - row.yardline), down = Math.abs(state.down - row.down);
  if (clock > OVERTIME_PARAMETERS.maximumClockDifference || field > OVERTIME_PARAMETERS.maximumFieldDifference || down > OVERTIME_PARAMETERS.maximumDownDifference) return Infinity;
  return Math.sqrt((clock / 180) ** 2 + (field / 20) ** 2 + down ** 2 + (Math.log1p(state.distance) - Math.log1p(row.distance)) ** 2 + ((state.ownTimeouts - row.ownTimeouts) / 2) ** 2 + ((state.opponentTimeouts - row.opponentTimeouts) / 2) ** 2);
}
export function overtimeNeighbors(game: Game, state: OvertimeState, reference: OvertimeReference): OvertimeReferenceState[] {
  const games = new Map<string, { row: OvertimeReferenceState; distance: number }>();
  for (const row of reference.rows) {
    // No current-season labels: changing a target game's final score cannot change its estimates.
    if (row.season >= game.season || row.gameId === game.id) continue;
    const distance = comparableDistance(state, row);
    if (distance > OVERTIME_PARAMETERS.maximumDistance) continue;
    const previous = games.get(row.gameId);
    if (!previous || distance < previous.distance) games.set(row.gameId, { row, distance });
  }
  return [...games.values()].sort((a, b) => a.distance - b.distance || a.row.gameId.localeCompare(b.row.gameId)).slice(0, OVERTIME_PARAMETERS.maximumGames).map(entry => entry.row);
}
export function overtimeOutcomeProbabilities(rows: OvertimeReferenceState[]): { win: number; loss: number; tie: number } {
  const counts = { win: 0.5, loss: 0.5, tie: 0.5 };
  for (const row of rows) counts[row.outcome] += 1;
  const denominator = rows.length + 1.5;
  return { win: counts.win / denominator, loss: counts.loss / denominator, tie: counts.tie / denominator };
}
export function estimateOvertimeTimeline(game: Game, plays: ProviderRow[], reference: OvertimeReference | null): OvertimeTimelinePoint[] {
  const valid = reference !== null && validOvertimeReference(reference);
  return buildOvertimeStates(game, plays).map(state => {
    const point: OvertimeTimelinePoint = { playId: state.playId, homeWp: null, awayWp: null, tieProbability: null, status: 'unavailable', reasonCode: state.reasonCode, modelVersion: OVERTIME_MODEL_VERSION, supportGames: 0, phase: state.phase };
    if (state.observedOutcome) return { ...point, status: 'observed', reasonCode: 'observed_terminal_result', homeWp: state.observedOutcome === 'home_win' ? 1 : 0, awayWp: state.observedOutcome === 'away_win' ? 1 : 0, tieProbability: state.observedOutcome === 'tie' ? 1 : 0 };
    if (state.reasonCode) return point;
    if (!valid || !reference) return { ...point, reasonCode: 'overtime_reference_missing_or_invalid' };
    const neighbors = overtimeNeighbors(game, state, reference);
    point.supportGames = neighbors.length;
    if (neighbors.length < OVERTIME_PARAMETERS.minimumGames) return { ...point, reasonCode: state.phase === 'opening_possession_both' ? 'insufficient_current_rule_opening_games' : 'insufficient_comparable_overtime_games' };
    const probabilities = overtimeOutcomeProbabilities(neighbors);
    return { ...point, status: 'experimental', reasonCode: 'empirical_overtime_not_calibrated', homeWp: state.posteam === game.homeTeam ? probabilities.win : probabilities.loss, awayWp: state.posteam === game.homeTeam ? probabilities.loss : probabilities.win, tieProbability: probabilities.tie };
  });
}
