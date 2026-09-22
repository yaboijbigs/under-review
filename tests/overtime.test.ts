import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Game } from '../packages/core/src/contracts.js';
import { normalizeRow, type ProviderRow } from '../packages/core/src/normalize.js';
import { buildOvertimeStates, estimateOvertimeTimeline, OVERTIME_MODEL_VERSION, OVERTIME_PARAMETERS, overtimeReferenceChecksum, type OvertimeReference, type OvertimeReferenceState } from '../packages/core/src/overtime.js';

const game: Game = { id: '2026_02_AAA_BBB', season: 2026, week: 2, gameType: 'REG', homeTeam: 'BBB', awayTeam: 'AAA', homeScore: 20, awayScore: 17, kickoffAt: null, providerData: {} };
const play = (patch: ProviderRow = {}): ProviderRow => ({ play_id: '1', qtr: 5, quarter_seconds_remaining: 500, posteam: 'BBB', defteam: 'AAA', down: 1, ydstogo: 10, yardline_100: 50, score_differential: 0, posteam_timeouts_remaining: 2, defteam_timeouts_remaining: 2, play_type: 'run', yards_gained: 2, desc: 'Ordinary play', ...patch });
const kickoff = play({ play_id: '0', quarter_seconds_remaining: 600, down: null, ydstogo: 0, yardline_100: 35, kickoff_attempt: 1, play_type: 'kickoff' });
const punt = play({ play_id: '2', down: 4, punt_attempt: 1, play_type: 'punt' });
const reply = play({ play_id: '3', posteam: 'AAA', defteam: 'BBB', quarter_seconds_remaining: 450 });
function reference(count = 25, patch: Partial<OvertimeReferenceState> = {}): OvertimeReference {
  const payload: Omit<OvertimeReference, 'checksum'> = { schemaVersion: 1, modelVersion: OVERTIME_MODEL_VERSION, startSeason: 2017, endSeason: 2025, parameters: OVERTIME_PARAMETERS, sources: [], notes: [],
    rows: Array.from({ length: count }, (_, index) => ({ gameId: `2023_${String(index + 1).padStart(2, '0')}_CCC_DDD`, season: 2023, playId: '100', phase: 'sudden_death', clock: 450, down: 1, distance: 10, yardline: 50, scoreDifference: 0, ownTimeouts: 2, opponentTimeouts: 2, outcome: index % 5 === 0 ? 'tie' : index % 2 === 0 ? 'win' : 'loss', ...patch })) };
  return { ...payload, checksum: overtimeReferenceChecksum(payload) };
}
const seal = (ref: OvertimeReference): OvertimeReference => ({ ...ref, checksum: overtimeReferenceChecksum(ref) });

describe('prefix-only overtime phase reconstruction', () => {
  it('distinguishes the opening rule eras and switches a punt/no-score reply into sudden death', () => {
    expect(buildOvertimeStates(game, [kickoff, play(), punt, reply]).map(p => p.phase)).toEqual(['opening_possession_both', 'opening_possession_both', 'opening_possession_both', 'sudden_death']);
    expect(buildOvertimeStates({ ...game, season: 2024 }, [kickoff, play()])[1].phase).toBe('opening_possession_legacy');
  });
  it('tracks a reply to an opening field goal, then tied sudden death', () => {
    const fg = play({ play_id: '2', field_goal_attempt: 1, field_goal_result: 'made', down: 4, total_home_score: 20, total_away_score: 17 });
    const replyFg = { ...reply, score_differential: -3 };
    const fg2 = { ...replyFg, play_id: '4', field_goal_attempt: 1, field_goal_result: 'made', down: 4 };
    const result = buildOvertimeStates(game, [kickoff, fg, replyFg, fg2, play({ play_id: '5', quarter_seconds_remaining: 150 })]);
    expect(result[1].phase).toBe('opening_possession_both');
    expect(result[2].phase).toBe('reply_to_field_goal');
    expect(result[4].phase).toBe('sudden_death');
  });
  it('withholds touchdown response and try states instead of importing legacy opening-TD labels', () => {
    const result = buildOvertimeStates(game, [kickoff, play({ touchdown: 1 }), play({ extra_point_attempt: 1, down: null }), { ...reply, score_differential: -7 }]);
    expect(result[1].phase).toBe('opening_possession_both');
    expect(result[2].reasonCode).toBe('unsupported_overtime_try');
    expect(result[3].reasonCode).toBe('unsupported_touchdown_response_phase');
  });
  it('treats an ordinary interception as a completed possession without using the outcome on its own preplay estimate', () => {
    const normal = buildOvertimeStates(game, [kickoff, play()]);
    const intercepted = buildOvertimeStates(game, [kickoff, play({ interception: 1 }), reply]);
    expect(intercepted[1]).toEqual(normal[1]);
    expect(intercepted[2].phase).toBe('sudden_death');
  });
  it('withholds ambiguous possession switches, missing opening evidence and special possession exceptions', () => {
    expect(buildOvertimeStates(game, [kickoff, play(), reply])[2].reasonCode).toBe('ambiguous_overtime_possession_transition');
    expect(buildOvertimeStates(game, [play()])[0].reasonCode).toBe('missing_overtime_opening_possession');
    expect(buildOvertimeStates(game, [{ ...kickoff, own_kickoff_recovery: 1 }, play()])[1].reasonCode).toBe('unsupported_overtime_possession_exception');
    expect(buildOvertimeStates(game, [kickoff, play({ safety: 1 }), reply])[2].reasonCode).toBe('unsupported_overtime_possession_exception');
  });
  it('does not consume an opportunity on a nullified turnover, and withholds blocked-kick branches', () => {
    const result = buildOvertimeStates(game, [kickoff, play({ interception: 1, penalty: 1, play_type: 'no_play' }), play({ play_id: '2' })]);
    expect(result[2].phase).toBe('opening_possession_both');
    const switched = buildOvertimeStates(game, [kickoff, play({ interception: 1, penalty: 1, play_type: 'no_play' }), reply]);
    expect(switched[2].reasonCode).toBe('ambiguous_overtime_possession_transition');
    expect(buildOvertimeStates(game, [kickoff, play({ field_goal_attempt: 1, field_goal_result: 'blocked' }), reply])[2].reasonCode).toBe('unsupported_overtime_possession_exception');
  });
  it('observes a defensive touchdown or safety terminal without manufacturing an intermediate estimate', () => {
    for (const result of [{ touchdown: 1, interception: 1 }, { safety: 1 }]) {
      const points = estimateOvertimeTimeline(game, [kickoff, play(result), play({ play_id: '99', desc: 'END GAME', total_home_score: 17, total_away_score: 23 })], reference());
      expect(points.at(-1)).toMatchObject({ status: 'observed', homeWp: 0, awayWp: 1, tieProbability: 0 });
    }
  });
  it('does not infer a final tie from an expired clock before the explicit terminal record', () => {
    const points = estimateOvertimeTimeline(game, [kickoff, play({ quarter_seconds_remaining: 0 }), play({ play_id: '99', desc: 'END GAME', total_home_score: 17, total_away_score: 17, quarter_seconds_remaining: 0 })], reference());
    expect(points[1]).toMatchObject({ status: 'unavailable', homeWp: null, reasonCode: 'expired_clock_without_terminal_result' });
    expect(points[2]).toMatchObject({ status: 'observed', homeWp: 0, awayWp: 0, tieProbability: 1 });
  });
  it('keeps postseason and 15-minute regular-season rules outside this estimator', () => {
    expect(buildOvertimeStates({ ...game, gameType: 'POST' }, [kickoff, play()])[1].reasonCode).toBe('unsupported_postseason_overtime');
    expect(buildOvertimeStates({ ...game, season: 2016 }, [kickoff, play()])[1].reasonCode).toBe('unsupported_overtime_rule_era_or_period');
  });
  it('preserves source order across non-monotonic timeout IDs and rejects missing state fields', () => {
    const timeout = play({ play_id: '999', posteam: null, defteam: null, down: null, desc: 'Timeout', quarter_seconds_remaining: 450 });
    const result = buildOvertimeStates(game, [kickoff, punt, timeout, { ...reply, play_id: '3' }]);
    expect(result.map(p => p.playId)).toEqual(['0', '2', '999', '3']);
    expect(result[3].phase).toBe('sudden_death');
    expect(buildOvertimeStates(game, [kickoff, punt, { ...reply, posteam_timeouts_remaining: null }])[2].reasonCode).toBe('missing_or_invalid_overtime_state');
  });
});

describe('experimental distinct-game estimator', () => {
  it('requires 20 distinct games, not correlated states from one game', () => {
    const repeated = reference(100, { gameId: '2023_01_CCC_DDD' });
    expect(estimateOvertimeTimeline(game, [kickoff, punt, reply], repeated)[2]).toMatchObject({ status: 'unavailable', supportGames: 1 });
    expect(estimateOvertimeTimeline(game, [kickoff, punt, reply], reference(19))[2].status).toBe('unavailable');
    expect(estimateOvertimeTimeline(game, [kickoff, punt, reply], reference(20))[2].status).toBe('experimental');
  });
  it('gives one closest observation per game equal weight and retains nonzero tie probability', () => {
    const ref = reference(25, { outcome: 'win' });
    const result = estimateOvertimeTimeline(game, [kickoff, punt, reply], ref)[2];
    expect(result.awayWp).toBeCloseTo(25.5 / 26.5);
    expect(result.homeWp).toBeCloseTo(.5 / 26.5);
    expect(result.tieProbability).toBeCloseTo(.5 / 26.5);
    expect(result.homeWp! + result.awayWp! + result.tieProbability!).toBeCloseTo(1);
    expect(result.status).toBe('experimental');
  });
  it('excludes current and future seasons, distant states, wrong phases and tampered references', () => {
    for (const patch of [{ season: 2026 }, { season: 2027 }, { yardline: 95 }, { phase: 'opening_possession_legacy' as const }]) expect(estimateOvertimeTimeline(game, [kickoff, punt, reply], reference(25, patch))[2].status).toBe('unavailable');
    const ref = reference(); ref.rows[0].outcome = 'win';
    expect(estimateOvertimeTimeline(game, [kickoff, punt, reply], ref)[2].reasonCode).toBe('overtime_reference_missing_or_invalid');
  });
  it('is invariant to target final score, future plays, play descriptions and future drive annotations', () => {
    const ref = reference();
    const original = estimateOvertimeTimeline(game, [kickoff, punt, reply], ref);
    const changed = estimateOvertimeTimeline({ ...game, homeScore: 99, awayScore: 0 }, [kickoff, punt, { ...reply, desc: 'Future-scoring description', drive_end_transition: 'TOUCHDOWN', fixed_drive_result: 'Touchdown', drive_ended_with_score: 1, total_home_score: 99, total_away_score: 0 }, play({ desc: 'END GAME', total_home_score: 99, total_away_score: 0 })], ref);
    expect(changed.slice(0, 3)).toEqual(original);
  });
  it('does not pool old first possessions into current first-possession estimates', () => {
    const ref = reference(100, { phase: 'opening_possession_legacy' });
    expect(estimateOvertimeTimeline(game, [kickoff, play()], ref)[1]).toMatchObject({ status: 'unavailable', supportGames: 0, reasonCode: 'insufficient_current_rule_opening_games' });
  });
  it('chooses only one best state from a historical game and caps the cohort at40', () => {
    const ref = reference(50);
    ref.rows.push({ ...ref.rows[0], playId: '101', yardline: 80, outcome: 'win' });
    const result = estimateOvertimeTimeline(game, [kickoff, punt, reply], seal(ref))[2];
    expect(result.supportGames).toBe(40);
  });
});

describe('frozen prior-season artifact and actual 2026 regression cases', () => {
  it('provides bounded GB and IND estimates, retains sparse/TD-response gaps, and observes terminal outcomes', async () => {
    const ref = JSON.parse(await readFile('analytics/models/overtime-reference.json', 'utf8')) as OvertimeReference;
    const fixture = JSON.parse(await readFile('tests/fixtures/real/overtime-2026.json', 'utf8')) as { games: { game: Game; plays: ProviderRow[] }[] };
    expect(ref.rows.every(row => row.season <= 2025)).toBe(true);
    const results = fixture.games.map(({ game: current, plays }) => estimateOvertimeTimeline(current, plays.map(normalizeRow), ref));
    expect(results[0].filter(point => point.status === 'experimental')).toHaveLength(5);
    expect(results[1].some(point => point.status === 'experimental' && point.phase === 'reply_to_field_goal')).toBe(true);
    expect(results[1].filter(point => point.status === 'experimental' && point.phase === 'sudden_death')).toHaveLength(7);
    expect(results[2].filter(point => point.status === 'experimental')).toHaveLength(0);
    for (const points of results) {
      expect(points.at(-1)?.status).toBe('observed');
      expect(points.filter(point => point.status === 'experimental').every(point => point.supportGames >= 20)).toBe(true);
      expect(points.filter(point => point.phase === 'opening_possession_both').every(point => point.homeWp === null)).toBe(true);
    }
  });
});
