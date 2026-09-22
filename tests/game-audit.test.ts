import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { gameAuditSchema, type Game, type GameProfile, type GameProfileReference } from '../packages/core/src/contracts.js';
import { buildGameAudit, GAME_AUDIT_PATTERN_LIBRARY,GAME_AUDIT_VERSION } from '../packages/core/src/game-audit.js';
import type { ProviderRow } from '../packages/core/src/normalize.js';

const game: Game = { id: '2026_01_AAA_BBB', season: 2026, week: 1, gameType: 'REG', homeTeam: 'BBB', awayTeam: 'AAA', homeScore: 17, awayScore: 20, kickoffAt: null, providerData: {} };
const winner = (patch: Partial<GameProfile> = {}): GameProfile => ({ gameId: game.id, season: game.season, team: game.awayTeam, opponent: game.homeTeam, pointsFor: 20, pointsAgainst: 17, totalYards: 199, opponentYards: 300, penalties: 14, penaltyYards: 100, turnoverMargin: -1, nonOffensiveTouchdowns: 0, ...patch });
const profiles = (patch: Partial<GameProfile> = {}): GameProfile[] => [winner(patch), winner({ team: game.homeTeam, opponent: game.awayTeam, pointsFor: 17, pointsAgainst: 20, totalYards: 300, opponentYards: 199, penalties: 4, penaltyYards: 30, turnoverMargin: 1 })];
function reference(count = 20, wins = 1, ties = 0): GameProfileReference {
  return { schemaVersion: 1, version: 'test-reference', startSeason: 2024, endSeason: 2025, sourceUrls: [], sourceChecksums: {}, notes: [], rows: Array.from({ length: count }, (_, index) => winner({ gameId: `2025_${index}_CCC_DDD`, season: 2025, team: 'CCC', opponent: 'DDD', pointsFor: index < wins ? 20 : index < wins + ties ? 17 : 10 })) };
}
const lateIncomplete = (patch: ProviderRow = {}): ProviderRow => ({ play_id: 100, qtr: 4, time: '02:00', quarter_seconds_remaining: 120, posteam: game.awayTeam, defteam: game.homeTeam, score_differential: -8, down: 3, yardline_100: 25, incomplete_pass: 1, desc: 'Pass incomplete short left.', ...patch });

describe('fixed descriptive game profile comparisons', () => {
  it.each([[1, 'historical_outlier'], [2, 'unusual_profile'], [3, 'no_flag_found']] as const)('applies the supported 20-match threshold with %i wins', (wins, status) => {
    const result = buildGameAudit({ game, profiles: profiles(), reference: reference(20, wins) });
    expect(result.status).toBe(status);
    expect(result.flags).toHaveLength(7);
    expect(result.flags[0].reference).toEqual({ startSeason: 2025, endSeason: 2025, teamGames: 20, matchingGames: 20, wins, losses: 20 - wins, ties: 0, winRate: wins / 20 });
    expect(gameAuditSchema.parse(result)).toEqual(result);
  });

  it.each([0, 19])('keeps %i matches explicit and withholds a rarity or win-rate claim', count => {
    const result = buildGameAudit({ game, profiles: profiles(), reference: reference(count, 0) });
    expect(result.status).toBe('insufficient_data');
    expect(result.flags[0].status).toBe('rare_sample');
    expect(result.flags[0].reference).toMatchObject({ matchingGames: count, winRate: null });
    expect(result.flags[0].detail).toContain('Fewer than 20 matches');
  });

  it('counts ties separately and includes them in the raw matching denominator', () => {
    const result = buildGameAudit({ game, profiles: profiles(), reference: reference(20, 1, 2) });
    expect(result.flags[0].reference).toMatchObject({ wins: 1, losses: 17, ties: 2, winRate: .05 });
  });

  it('excludes same-season, future, incomplete and conflicting records and deduplicates identities', () => {
    const source = reference();
    source.rows.push({ ...source.rows[0] });
    source.rows.push(winner({ gameId: 'same-season' }), winner({ gameId: 'future', season: 2027 }), winner({ gameId: 'incomplete', season: 2024, penaltyYards: null }));
    source.rows.push(winner({ gameId: 'conflict', season: 2024 }), winner({ gameId: 'conflict', season: 2024, pointsFor: 7 }));
    source.rows.push(winner({ gameId: 'nonfinite-season', season: Number.NaN }));
    const result = buildGameAudit({ game, profiles: profiles(), reference: source });
    expect(result.reference.teamGames).toBe(20);
    expect(result.reference.endSeason).toBe(2025);
    expect(result.notes).toContain('1 conflicting duplicate historical team-game records were excluded.');
    expect(source.rows).toHaveLength(27);
  });

  it('uses fixed boundaries and only flags a winning team', () => {
    const result = buildGameAudit({ game, profiles: profiles({ totalYards: 200, turnoverMargin: 0 }), reference: reference() });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].conditions).toEqual(['At least 100 penalty yards']);
    expect(result.flags.every(flag => flag.team === game.awayTeam)).toBe(true);
    const tied = { ...game, homeScore: 20 };
    expect(buildGameAudit({ game: tied, profiles: profiles().map(p => ({ ...p, pointsFor: 20, pointsAgainst: 20 })), reference: reference() }).flags).toEqual([]);
    expect(GAME_AUDIT_PATTERN_LIBRARY).toHaveLength(7);
  });

  it('retains review triggers without aggregates or a reference and never approximates penalties from PBP', () => {
    const result = buildGameAudit({ game, reference: undefined, plays: [lateIncomplete({ penalty: 1, penalty_yards: 150 })] });
    expect(result.status).toBe('review_worthy');
    expect(result.flags).toEqual([]);
    expect(result.profiles.every(profile => profile.penaltyYards === null && profile.totalYards === null)).toBe(true);
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reference.teamGames).toBe(0);
  });

  it('withholds aggregate statistics when their final score or identity conflicts', () => {
    const result = buildGameAudit({ game, profiles: profiles({ pointsFor: 21 }), reference: reference() });
    expect(result.flags).toEqual([]);
    expect(result.profiles.find(profile => profile.team === game.awayTeam)).toMatchObject({ pointsFor: 20, totalYards: null });
    expect(result.notes.join(' ')).toContain('conflict');
  });

  it('has the same findings after arbitrary consistent renaming of teams and game identity', () => {
    const original = buildGameAudit({ game, profiles: profiles(), reference: reference() });
    const renamed = { ...game, id: '2026_01_XXX_YYY', homeTeam: 'YYY', awayTeam: 'XXX' };
    const transformed = buildGameAudit({ game: renamed, profiles: profiles().map(profile => ({ ...profile, gameId: renamed.id, team: profile.team === game.homeTeam ? 'YYY' : 'XXX', opponent: profile.opponent === game.homeTeam ? 'YYY' : 'XXX' })), reference: reference() });
    expect(transformed.status).toBe(original.status);
    expect(transformed.flags.map(flag => [flag.conditions, flag.status, flag.reference])).toEqual(original.flags.map(flag => [flag.conditions, flag.status, flag.reference]));
  });
});

describe('neutral review priorities and observed game context', () => {
  it('deduplicates a replay-reversed nullified scoring play with a late penalty and links its existing event', () => {
    const play = lateIncomplete({ play_id: 77, incomplete_pass: 0, touchdown: 0, penalty: 1, replay_or_challenge_result: 'reversed', play_type: 'no_play', desc: 'Pass complete for a TOUCHDOWN. The ruling was reversed. PENALTY on defense, No Play.' });
    const result = buildGameAudit({ game, plays: [play, { ...play }], events: [{ id: 'existing-77', playId: '77', quarter: 4, clock: '02:00', description: String(play.desc), kind: 'penalty', team: game.awayTeam, reviewStatus: 'not_reviewed' }] });
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reviewCandidates[0]).toMatchObject({ priority: 'high', existingEventId: 'existing-77' });
    expect(result.reviewCandidates[0].reasons).toHaveLength(3);
  });

  it.each(['upheld', 'not reversed'])('does not treat %s replay as an automatic correction priority', result => {
    expect(buildGameAudit({ game, plays: [{ play_id: 1, qtr: 1, desc: 'Pass complete.', replay_or_challenge_result: result }] }).reviewCandidates).toEqual([]);
  });

  it('recognizes explicitly nullified two-point plays even without a touchdown flag', () => {
    const result = buildGameAudit({ game, plays: [{ play_id: 5, qtr: 2, desc: 'TWO-POINT CONVERSION ATTEMPT. PENALTY. No Play.', two_point_attempt: 1 }] });
    expect(result.reviewCandidates[0].reasons).toEqual(['A touchdown or two-point play was explicitly nullified.']);
  });

  it('keeps an upheld final-minute catch or score visible as a neutral review priority', () => {
    // Actual 2012_03_GB_SEA play 4153 source fields; no game-specific rule.
    const result = buildGameAudit({ game, plays: [{ play_id: 4153, qtr: 4, quarter_seconds_remaining: 8, time: '00:08', score_differential: -5, touchdown: 1, replay_or_challenge: 1, replay_or_challenge_result: 'upheld', desc: '(:08) (Shotgun) 3-R.Wilson pass deep left to 81-G.Tate for 24 yards, TOUCHDOWN [52-C.Matthews]. The Replay Assistant challenged the pass completion ruling, and the play was Upheld.' }] });
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reviewCandidates[0].reasons).toEqual(['Catch or scoring ruling reviewed in the final minute of a one-score game; an upheld ruling is not an error finding.']);
    expect(result.reviewCandidates[0].priority).toBe('high');
  });

  it('includes the exact late-incompletion boundaries without assigning an officiating error', () => {
    const result = buildGameAudit({ game, plays: [lateIncomplete()] });
    expect(result.reviewCandidates[0].priority).toBe('high');
    expect(result.headline).toContain('no call-correctness judgment');
    expect(result.notes.join(' ')).toContain('not adjudicated errors');
  });

  it.each([{ qtr: 3 }, { quarter_seconds_remaining: 121 }, { down: 2 }, { yardline_100: 26 }, { score_differential: -9 }, { score_differential: null }, { quarter_seconds_remaining: -1 }, { quarter_seconds_remaining: null, time: null, game_seconds_remaining: -1 }])('excludes incompletion outside an explicit condition: %o', patch => {
    expect(buildGameAudit({ game, plays: [lateIncomplete(patch)] }).reviewCandidates).toEqual([]);
  });

  it('recognizes late regulation and overtime penalties, while omitting overtime WP', () => {
    const result = buildGameAudit({ game, plays: [
      lateIncomplete({ play_id: 1, quarter_seconds_remaining: 300, incomplete_pass: 0, desc: 'PENALTY on defense.', penalty: 1, wpa: -.2 }),
      lateIncomplete({ play_id: 2, qtr: 5, incomplete_pass: 0, desc: 'PENALTY on defense.', penalty: 1, wpa: .7 }),
      lateIncomplete({ play_id: 3, quarter_seconds_remaining: 301, incomplete_pass: 0, desc: 'PENALTY on defense.', penalty: 1 }),
    ] });
    expect(result.reviewCandidates.map(candidate => candidate.playId)).toEqual(['1', '2']);
    expect(result.reviewCandidates.map(candidate => candidate.observedWpSwing)).toEqual([.2, null]);
  });

  it('reports WP only as whole-play absolute movement with no beneficiary inference', () => {
    const result = buildGameAudit({ game, plays: [lateIncomplete({ home_wp: .8, home_wp_post: .3, wpa: .8 })] });
    expect(result.reviewCandidates[0].observedWpSwing).toBe(.5);
    expect(result.notes.join(' ')).toContain('never a beneficiary attribution');
    expect(gameAuditSchema.parse(result)).toEqual(result);
  });

  it('keeps sacks including overtime, opponent aggregate penalties and return scores as observed context', () => {
    const result = buildGameAudit({ game, profiles: profiles({ nonOffensiveTouchdowns: 1 }), plays: [
      { play_id: 1, qtr: 3, posteam: game.awayTeam, sack: 1 },
      { play_id: 2, qtr: 5, posteam: game.awayTeam, sack: 1 },
      { play_id: 3, qtr: 3, posteam: game.awayTeam, sack: 1, play_type: 'no_play' },
      { play_id: 4, punt_attempt: 1, return_yards: 40, defteam: game.awayTeam, td_team: game.awayTeam, touchdown: 1, return_touchdown: 1 },
      { play_id: 5, punt_attempt: 1, return_yards: 39, defteam: game.homeTeam },
    ] });
    expect(result.context.find(context => context.kind === 'sacks_allowed')).toMatchObject({ team: game.awayTeam, playIds: ['1', '2'], text: 'Allowed 2 sacks, including 1 in overtime.' });
    expect(result.context.find(context => context.kind === 'opponent_penalties' && context.team === game.awayTeam)?.text).toContain('4 penalties for 30 yards');
    expect(result.context.find(context => context.kind === 'non_offensive_touchdowns')?.playIds).toEqual(['4']);
    expect(result.context.filter(context => context.kind === 'long_punt_return')).toEqual([{ team: game.awayTeam, kind: 'long_punt_return', text: '40-yard punt return.', playIds: ['4'] }]);
  });
});

describe('frozen attributable aggregate reference', () => {
  it('computes the real current validation game from uniform definitions and strictly prior seasons', async () => {
    const frozen = JSON.parse(await readFile('analytics/models/game-profiles.json', 'utf8')) as GameProfileReference;
    const validation = JSON.parse(await readFile('analytics/models/game-profile-validation.json', 'utf8')) as { profiles: GameProfile[] };
    const away = validation.profiles.find(profile => profile.team === 'GB')!;
    const currentGame: Game = { ...game, id: away.gameId, homeTeam: away.opponent, awayTeam: away.team, awayScore: away.pointsFor, homeScore: away.pointsAgainst, week: 2 };
    const result = buildGameAudit({ game: currentGame, profiles: validation.profiles, reference: frozen });
    expect(result.reference.teamGames).toBe(14512);
    expect(result.reference.endSeason).toBe(2025);
    expect(result.profiles.find(profile => profile.team === 'GB')).toMatchObject({ totalYards: 199, penaltyYards: 133, turnoverMargin: -1 });
    expect(result.flags).toHaveLength(7);
    expect(result.flags[0].conditions).toHaveLength(3);
    expect(result.flags[0].reference).toMatchObject({ matchingGames: 14, wins: 0, losses: 14, ties: 0, winRate: null });
    expect(result.flags.find(flag => flag.status === 'historical_outlier')?.reference).toMatchObject({ matchingGames: 414, wins: 6, losses: 408, ties: 0 });
    expect(result.headline).toContain('total offense below 200 yards and negative turnover margin; 6 wins in 414');
    expect(result.notes.join(' ')).toContain('motivated by known cases');
    expect(gameAuditSchema.parse(result)).toEqual(result);
  });
});

describe('defensive penalties extending third and fourth downs',()=>{
  const gbMin:Game={...game,id:'2026_01_GB_MIN',homeTeam:'MIN',awayTeam:'GB',homeScore:39,awayScore:22};
  // Exact identity/timing/down/penalty fields and descriptions from the preserved
  // 2026 clean PBP snapshot. No call-correctness claim is part of this fixture.
  const drive:ProviderRow[]=[
    {play_id:3411,time:'11:03',down:3,ydstogo:11,penalty_type:'Illegal Contact',desc:'(11:03) (Shotgun) 11-C.Wentz sacked at MIN 24 for -10 yards (sack split by 56-E.Cooper and 95-D.Wyatt). PENALTY on GB-7-J.Bullard, Illegal Contact, 5 yards, enforced at MIN 34 - No Play.'},
    {play_id:3489,time:'09:12',down:3,ydstogo:3,penalty_type:'Roughing the Passer',desc:'(9:12) (Shotgun) 11-C.Wentz pass incomplete short middle to 87-T.Hockenson (55-C.McClellan). PENALTY on GB-55-C.McClellan, Roughing the Passer, 15 yards, enforced at MIN 46 - No Play.'},
    {play_id:3592,time:'06:49',down:3,ydstogo:5,penalty_type:'Defensive Holding',desc:'(6:49) (Shotgun) 11-C.Wentz pass short middle intended for 3-J.Addison INTERCEPTED by 33-E.Williams [98-J.Hargrave] at GB -4. 33-E.Williams to GB 13 for 17 yards (33-A.Jones). PENALTY on GB-29-X.McKinney, Defensive Holding, 3 yards, enforced at GB 6 - No Play.'},
  ].map(play=>({game_id:gbMin.id,qtr:4,posteam:'MIN',defteam:'GB',penalty_team:'GB',penalty:1,first_down_penalty:1,first_down_pass:0,first_down_rush:0,drive:19,fixed_drive:19,score_differential:-5,replay_or_challenge:0,...play}));
  const inspect=(plays:ProviderRow[])=>buildGameAudit({game:gbMin,plays});
  const clusters=(plays:ProviderRow[])=>inspect(plays).context.filter(row=>row.kind==='drive_extending_penalties');

  it('flags all three documented early fourth-quarter extensions and groups the drive',()=>{
    const audit=inspect(drive);
    expect(audit.version).toBe(GAME_AUDIT_VERSION);expect(GAME_AUDIT_VERSION).toBe('under-review-game-audit-v2');
    expect(audit.reviewCandidates.map(row=>row.playId)).toEqual(['3411','3489','3592']);
    expect(audit.reviewCandidates.every(row=>row.priority==='high')).toBe(true);
    expect(audit.reviewCandidates.every(row=>row.reasons.length===2)).toBe(true);
    expect(clusters(drive)).toEqual([{team:'MIN',kind:'drive_extending_penalties',playIds:['3411','3489','3592'],text:'MIN received 3 first downs from GB penalties on third or fourth down during drive 19. Review these plays together; this does not establish that any call was wrong.'}]);
    expect(audit.flags).toEqual([]);expect(audit.status).toBe('review_worthy');
    expect(gameAuditSchema.parse(audit)).toEqual(audit);
  });
  it.each([1,2,3,4,5])('flags a structured fourth-down penalty in period %i without requiring a close score',qtr=>{
    const audit=inspect([{...drive[0],qtr,time:'12:00',down:4,score_differential:-24}]);
    expect(audit.reviewCandidates).toHaveLength(1);
    expect(audit.reviewCandidates[0]).toMatchObject({priority:'medium',reasons:['Defensive penalty on GB awarded MIN a first down on fourth down; call correctness requires review.']});
    expect(clusters([{...drive[0],qtr,down:4}])).toEqual([]);
  });
  it.each([
    {penalty:0},{first_down_penalty:0},{down:2},{down:null},{posteam:'UNK'},{defteam:'UNK'},{penalty_team:'MIN'},
    {penalty_team:null},{penalty_type:'Unknown'},{penalty_type:null},{game_id:'2026_02_GB_MIN'},{first_down_pass:1},{first_down_rush:1},
    {desc:'PENALTY on GB, Illegal Contact, declined.'},{desc:'PENALTY on GB, Illegal Contact, offsetting.'},
    {desc:'PENALTY on GB, Illegal Contact. PENALTY on MIN, Holding.'},{desc:'PENALTY flag picked up.'},
  ])('excludes unsupported or ambiguous penalty attribution: %o',patch=>{
    expect(inspect([{...drive[0],...patch}]).reviewCandidates).toEqual([]);
  });
  it('retains individual flags without inventing a shared drive when IDs are missing or invalid',()=>{
    for(const missing of [{fixed_drive:null,drive:null},{fixed_drive:0},{fixed_drive:'unknown'}]){
      const plays=drive.map(play=>({...play,...missing}));
      expect(inspect(plays).reviewCandidates).toHaveLength(3);
      expect(inspect(plays).reviewCandidates.every(row=>row.priority==='medium')).toBe(true);
      expect(clusters(plays)).toEqual([]);
    }
  });
  it('keeps distinct drive IDs separate and uses an explicit legacy drive when corrected IDs are absent',()=>{
    expect(clusters(drive.map((play,index)=>({...play,fixed_drive:19+index,drive:19+index})))).toEqual([]);
    expect(clusters(drive.map(play=>({...play,fixed_drive:null})))[0].playIds).toEqual(['3411','3489','3592']);
  });
  it('does not combine opposing possessions even if a provider reuses the same drive number',()=>{
    const other={...drive[1],posteam:'GB',defteam:'MIN',penalty_team:'MIN'};
    expect(clusters([drive[0],other])).toEqual([]);
  });
  it('deduplicates repeated source rows and quarantines conflicting play IDs',()=>{
    expect(clusters([drive[0],{...drive[0]}])).toEqual([]);
    expect(inspect([drive[0],{...drive[0]}]).reviewCandidates).toHaveLength(1);
    expect(clusters([...drive,{...drive[0]}])[0].playIds).toEqual(['3411','3489','3592']);
    const conflict={...drive[0],penalty_team:'MIN'};
    expect(inspect([drive[0],conflict,drive[1]]).reviewCandidates.map(row=>row.playId)).toEqual(['3489']);
    expect(clusters([drive[0],conflict,drive[1]])).toEqual([]);
  });
  it('does not infer an uncalled foul on the subsequent successful two-point conversion',()=>{
    const play={game_id:gbMin.id,play_id:3648,qtr:4,time:'06:37',posteam:'MIN',defteam:'GB',down:null,penalty:0,first_down_penalty:0,two_point_attempt:1,two_point_conv_result:'success',desc:'TWO-POINT CONVERSION ATTEMPT. 11-C.Wentz pass to 18-J.Jefferson is complete. ATTEMPT SUCCEEDS.'};
    expect(inspect([play]).reviewCandidates).toEqual([]);
  });
});
