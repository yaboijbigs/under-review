import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Game } from '../packages/core/src/contracts.js';
import { extractOfficiatingObservation, hasVerifiedGameOpening } from '../packages/core/src/officiating-observations.js';
import { normalizePlays, normalizeSchedule, parseCsv, type ProviderRow } from '../packages/core/src/normalize.js';

const game: Game = { id: '2025_01_AAA_BBB', season: 2025, week: 1, gameType: 'REG', homeTeam: 'BBB', awayTeam: 'AAA', homeScore: 7, awayScore: 3, kickoffAt: null, providerData: {} };
const play = (patch: ProviderRow = {}): ProviderRow => ({ game_id: game.id, play_id: 10, qtr: 1, play_type: 'pass', posteam: 'BBB', defteam: 'AAA', down: 3, ydstogo: 8, yardline_100: 60, half_seconds_remaining: 1200, game_seconds_remaining: 3000, score_differential: 0, posteam_timeouts_remaining: 3, defteam_timeouts_remaining: 3, home_opening_kickoff: 1, total_home_score: 0, total_away_score: 0, fixed_drive: 1, desc: 'Pass incomplete short left.', ...patch });
const marker = (id: number, qtr: number, home: number, away: number, desc: string): ProviderRow => ({ play_id: id, qtr, total_home_score: home, total_away_score: away, half_seconds_remaining: 0, desc });
const completed = (): ProviderRow[] => [
  marker(1, 1, 0, 0, 'GAME'),
  play(),
  play({ play_id: 20, down: 1, touchdown: 1, total_home_score: 6, desc: 'Pass complete for a touchdown.' }),
  play({ play_id: 30, play_type: 'extra_point', extra_point_attempt: 1, total_home_score: 7, desc: 'Extra point is good.' }),
  marker(40, 2, 7, 0, 'END QUARTER 2'),
  play({ play_id: 50, qtr: 3, posteam: 'AAA', defteam: 'BBB', total_home_score: 7, score_differential: -7, game_seconds_remaining: 1000 }),
  play({ play_id: 60, qtr: 3, play_type: 'field_goal', field_goal_attempt: 1, posteam: 'AAA', defteam: 'BBB', total_home_score: 7, total_away_score: 3, desc: 'Field goal is good.' }),
  play({ play_id: 70, qtr: 4, total_home_score: 7, total_away_score: 3, score_differential: 4, game_seconds_remaining: 500 }),
  marker(80, 4, 7, 3, 'END GAME'),
];
const penalty = (patch: ProviderRow = {}): ProviderRow => play({ play_type: 'no_play', penalty: 1, penalty_type: 'Defensive Holding', penalty_team: 'AAA', penalty_yards: 5, first_down_penalty: 1, desc: 'Pass incomplete short left. PENALTY on AAA-D.Player, Defensive Holding, 5 yards, No Play.', ...patch });
const post = (patch: ProviderRow = {}): ProviderRow => play({ play_id: 20, down: 1, ydstogo: 10, yardline_100: 55, half_seconds_remaining: 1190, game_seconds_remaining: 2990, ...patch });

describe('compact officiating observations', () => {
  it('keeps accepted penalty no-play opportunities without inventing a pass opportunity', () => {
    const p = penalty({ penalty_type: 'False Start', penalty_team: 'BBB', first_down_penalty: 0, desc: 'PENALTY on BBB-O.Player, False Start, 5 yards, No Play.' });
    const result = extractOfficiatingObservation(game, [p, post({ down: 3, ydstogo: 13, yardline_100: 65 })]);
    expect(result.opportunities[0]).toMatchObject({ playKind: 'unknown', penaltyStatus: 'accepted', penalty: { family: 'offensive_presnap', firstDownExtension: false } });
    expect(result.coverage).toMatchObject({ regulationOpportunities: 2, unknownPlayKind: 1, acceptedPenalties: 1, valuedStatePairs: 1 });
    expect(result.opportunities[0].penalty?.actualState?.gameSecondsRemaining).toBe(3000);
    expect(result.opportunities[0].penalty?.alternativeState?.yardline100).toBe(60);
  });

  it('excludes nullified kicks from scrimmage exposure when attempt flags have been cleared', () => {
    const result = extractOfficiatingObservation(game, [
      penalty({ penalty_type: 'Roughing the Kicker', desc: 'Punter punts 50 yards. PENALTY on AAA-P.Player, Roughing the Kicker, 15 yards.' }),
      penalty({ play_id: 20, penalty_type: 'Holding', penalty_team: 'BBB', desc: '(Punt formation) P.Player punts 45 yards. PENALTY on BBB-P.Player, Holding, 10 yards.' }),
      penalty({ play_id: 30, penalty_type: 'Delay of Game', penalty_team: 'BBB', desc: 'PENALTY on BBB, Delay of Game, 5 yards.' }),
    ]);
    expect(result.opportunities.map(p => p.playId)).toEqual(['30']);
    expect(result.coverage.excludedRows.special_teams_no_play).toBe(2);
    expect(result.opportunities[0].penalty?.family).toBe('offensive_presnap');
  });

  it('constructs incomplete-pass enforcement alternatives without borrowing whole-play WPA', () => {
    const result = extractOfficiatingObservation(game, [penalty({ home_wp: .2, home_wp_post: .8 }), post()]);
    const opportunity = result.opportunities[0];
    expect(opportunity.observedHomeWpChange).toBeCloseTo(.6);
    expect(opportunity.penalty).toMatchObject({ family: 'defensive_pass', firstDownExtension: true, actualState: { down: 1, yardline100: 55 }, alternativeState: { down: 4, yardline100: 60, gameSecondsRemaining: 2990 }, valuationReason: null });
    expect(opportunity.penalty).not.toHaveProperty('wpa');
    expect(opportunity.penalty?.assumption).toContain('does not estimate a foul-free play');
  });

  it('flips possession, field, score and timeouts on a fourth-down incompletion alternative', () => {
    const result = extractOfficiatingObservation(game, [penalty({ down: 4, score_differential: 7, posteam_timeouts_remaining: 2 }), post({ score_differential: 7, posteam_timeouts_remaining: 2 })]);
    expect(result.opportunities[0].penalty?.alternativeState).toMatchObject({ possessionTeam: 'AAA', defenseTeam: 'BBB', yardline100: 40, down: 1, yardsToGo: 10, scoreDifference: -7, possessionTimeouts: 3, defenseTimeouts: 2, receivesSecondHalfKickoff: 1 });
  });

  it.each([
    [{ desc: 'Pass incomplete. PENALTY on AAA-X, Defensive Holding, 5 yards, declined.' }, 'declined_offsetting_or_removed'],
    [{ desc: 'Pass incomplete. PENALTY on AAA-X, Defensive Holding. PENALTY on BBB-X, Holding.' }, 'multiple_penalties'],
    [{ desc: 'Pass incomplete. PENALTY on BBB-X, Defensive Holding, 5 yards.' }, 'penalty_identity_conflict'],
    [{ penalty: 0 }, 'unconfirmed_accepted_penalty'],
  ] as [ProviderRow, string][])('retains ambiguous opportunities but never labels their penalty as absent: %j', (patch, reason) => {
    const result = extractOfficiatingObservation(game, [penalty(patch), post()]);
    expect(result.opportunities[0]).toMatchObject({ penaltyStatus: 'excluded', penalty: null, penaltyExclusionReason: reason });
    expect(result.coverage.excludedPenalties).toBe(1);
  });

  it.each([
    [{ replay_or_challenge_result: 'reversed' }, {}, 'scoring_turnover_or_replay'],
    [{ touchdown: 1 }, {}, 'scoring_turnover_or_replay'],
    [{ half_seconds_remaining: 110 }, {}, 'clock_or_period_ambiguity'],
    [{}, { yardline_100: 30 }, 'enforcement_geometry_mismatch'],
    [{}, { posteam_timeouts_remaining: 2 }, 'intervening_state_change'],
    [{ qtr: 5 }, { qtr: 5 }, 'unsupported_overtime'],
  ] as [ProviderRow, ProviderRow, string][])('withholds a counterfactual for unsupported conditions: %j', (before, after, reason) => {
    const result = extractOfficiatingObservation(game, [penalty(before), post(after)]);
    expect(result.opportunities[0].penalty).toMatchObject({ actualState: null, alternativeState: null, valuationReason: reason });
  });

  it('does not count an independently converted third down as an extension', () => {
    expect(extractOfficiatingObservation(game, [penalty({ first_down_pass: 1 }), post()]).opportunities[0].penalty?.firstDownExtension).toBe(false);
  });

  it('deduplicates identical rows, excludes conflicting IDs, and keeps source chronology rather than play IDs', () => {
    const first = penalty({ play_id: 900, source_order: 0 });
    const second = post({ play_id: 100, source_order: 1 });
    const result = extractOfficiatingObservation(game, [second, { ...first }, first, play({ play_id: 99, source_order: 2 }), play({ play_id: 99, source_order: 2, down: 2 })]);
    expect(result.opportunities.map(p => p.playId)).toEqual(['900', '100']);
    expect(result.coverage).toMatchObject({ duplicateRows: 1, conflictingPlayIds: 1, valuedStatePairs: 1 });
    expect(result.opportunities.every(p => p.labels.nextScore === null)).toBe(true);
  });

  it('never bridges an excluded conflicting row into a post-ruling state pair', () => {
    const result = extractOfficiatingObservation(game, [penalty(), post({ play_id: 15 }), post({ play_id: 15, ydstogo: 9 }), post()]);
    expect(result.opportunities[0].penalty).toMatchObject({ actualState: null, alternativeState: null, valuationReason: 'missing_post_ruling_state' });
  });

  it('rejects a penalty type disagreement between corrected provider identity and the clause', () => {
    const result = extractOfficiatingObservation(game, [penalty({ penalty_type: 'Defensive Pass Interference' }), post()]);
    expect(result.opportunities[0]).toMatchObject({ penaltyStatus: 'excluded', penaltyExclusionReason: 'penalty_identity_conflict' });
  });

  it('keeps regulation outcome labels isolated, using scoreboard deltas including non-opportunity scoring rows', () => {
    const result = extractOfficiatingObservation(game, completed());
    expect(result.opportunities.map(p => [p.playId, p.labels.nextScore, p.labels.homeWin])).toEqual([['10', 7, 1], ['20', 7, 1], ['50', 3, 1], ['70', 0, 1]]);
    expect(result.opportunities[0].state).not.toHaveProperty('homeScore');
    expect(result.opportunities[0].state).not.toHaveProperty('nextScore');
    expect(result.opportunities[0]).not.toHaveProperty('description');
  });

  it('signs opponent scoring events for the preplay offense and never carries scores across halftime', () => {
    const rows = completed();
    rows[2] = play({ play_id: 20, touchdown: 1, posteam: 'AAA', defteam: 'BBB', total_home_score: 6 });
    rows.splice(4, 0, play({ play_id: 35, total_home_score: 7, qtr: 2 }));
    const result = extractOfficiatingObservation(game, rows);
    expect(result.opportunities.find(p => p.playId === '20')?.labels.nextScore).toBe(-7);
    expect(result.opportunities.find(p => p.playId === '35')?.labels.nextScore).toBe(0);
  });

  it('withholds all future labels for truncated or final-score-conflicting games', () => {
    for (const rows of [completed().slice(0, -1), completed().map(p => p.desc === 'END GAME' ? { ...p, total_home_score: 8 } : p)]) {
      const result = extractOfficiatingObservation(game, rows);
      expect(result.opportunities.every(p => p.labels.nextScore === null && p.labels.homeWin === null)).toBe(true);
    }
  });

  it('accepts an explicit final marker followed by provider notes without accepting incidental mentions', () => {
    const rows = completed(); rows[rows.length - 1] = { ...rows.at(-1), desc: 'END GAME NE 12-Brady 161st win as starting QB with one team, new NFL record' };
    expect(extractOfficiatingObservation(game, rows).opportunities.every(p => p.labels.homeWin === 1)).toBe(true);
    rows[rows.length - 1].desc = 'Officials discussing END GAME timing.';
    expect(extractOfficiatingObservation(game, rows).opportunities.every(p => p.labels.homeWin === null)).toBe(true);
  });

  it('uses an observed opening kickoff after an annotated stadium marker without injecting rows', () => {
    const rows = completed(); rows[0].desc = 'GAME Team Captains: JAX - 16,19,51; CAR - 1,88,59';
    const kickoff = play({ play_id: 2, play_type: 'kickoff', kickoff_attempt: 1, game_seconds_remaining: 3600, half_seconds_remaining: 1800, posteam_score: 0, defteam_score: 0 });
    rows.splice(1, 0, kickoff);
    expect(hasVerifiedGameOpening(rows)).toBe(true);
    expect(extractOfficiatingObservation(game, rows).opportunities.every(p => p.labels.homeWin === 1 && p.labels.nextScore !== null)).toBe(true);
    expect(extractOfficiatingObservation(game, rows.slice(1)).opportunities.every(p => p.labels.homeWin === 1)).toBe(true);
    for (const patch of [{ game_seconds_remaining: 3590 }, { posteam_score: 3 }, { defteam_score: null }, { kickoff_attempt: 0 }]) {
      const changed = rows.map(p => p.play_id === 2 ? { ...p, ...patch } : p);
      expect(hasVerifiedGameOpening(changed)).toBe(false);
      expect(extractOfficiatingObservation(game, changed).opportunities.every(p => p.labels.homeWin === null)).toBe(true);
    }
    expect(rows).toHaveLength(10);
  });

  it('withholds labels in a half with a decreasing scoreboard and all home-win labels', () => {
    const rows = completed(); rows[3] = { ...rows[3], total_home_score: 5 };
    const result = extractOfficiatingObservation(game, rows);
    expect(result.opportunities.filter(p => p.state.quarter <= 2).every(p => p.labels.nextScore === null)).toBe(true);
    expect(result.opportunities.every(p => p.labels.homeWin === null)).toBe(true);
  });

  it('retains overtime context with no regulation-model valuation or outcomes and signs away WPA', () => {
    const result = extractOfficiatingObservation(game, [penalty({ qtr: 5, home_wp: .1, home_wp_post: .9 }), post({ qtr: 5 }), play({ play_id: 30, posteam: 'AAA', defteam: 'BBB', wpa: .2 })]);
    expect(result.coverage.overtimeOpportunities).toBe(2);
    expect(result.opportunities[0]).toMatchObject({ observedHomeWpChange: null, labels: { nextScore: null, homeWin: null } });
    expect(result.opportunities[2].observedHomeWpChange).toBe(-.2);
  });

  it('handles a real completed NFL game without mutating provider rows', () => {
    const schedule = parseCsv(readFileSync('tests/fixtures/real/schedules.csv')).find(row => row.game_id === '2023_01_DET_KC')!;
    const target = normalizeSchedule(schedule);
    const rows = normalizePlays(parseCsv(readFileSync('tests/fixtures/real/2023_01_DET_KC.pbp.csv')), target.id);
    const before = JSON.stringify(rows);
    const result = extractOfficiatingObservation(target, rows);
    expect(result.coverage.regulationOpportunities).toBeGreaterThan(100);
    expect(result.coverage.nextScoreLabels).toBe(result.opportunities.length);
    expect(result.opportunities.every(p => p.labels.homeWin === 0)).toBe(true);
    expect(result.coverage.acceptedPenalties).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
