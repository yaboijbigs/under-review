import { describe, expect, it } from 'vitest';
import type { GameAudit } from '../packages/core/src/contracts.js';
import { getGameVerdict } from '../packages/core/src/consumer-summary.js';
import { buildExpectations, loadExpectationsReference } from '../packages/core/src/expectations.js';
import { addExpectationCluster, expectationMarket, expectationsFixture } from './consumer-expectations.fixture.js';

describe('validated expectations-based consumer ratings',()=>{
 it.each([[7,4],[8,3],[25,3],[26,2],[52,2],[53,1]] as const)('uses the add-one, three-family boundary for %i comparison games', (outcomeCount,rating)=>{
  expect(getGameVerdict(expectationsFixture({outcomeCount}).audit)).toMatchObject({rating,rulesVersion:'game-suspicion-v3'});
 });
 it.each(['outcome','penalty'] as const)('does not let a rarer market result hide a stronger %s rating',kind=>{
  const {audit}=expectationsFixture({outcomeCount:kind==='outcome'?5:200,penaltyCount:kind==='penalty'?5:200});audit.market=expectationMarket(0);
  const result=getGameVerdict(audit);expect(result.rating).toBe(4);expect(result.reasons[0]).toContain(kind==='outcome'?'box-score expectation':'Penalty patterns');expect(result.reasons.at(-1)).toContain('spread');
 });
 it('caps a market-only anomaly at Hmm and describes that signal, even with no review candidates',()=>{
  const {audit}=expectationsFixture();audit.market=expectationMarket(0);
  expect(getGameVerdict(audit)).toMatchObject({rating:3,reviewCount:0,reasons:['The final margin missed the spread by 27 points.']});
  audit.market=expectationMarket(40);expect(getGameVerdict(audit)).toMatchObject({rating:2,reviewCount:0});
 });
 it('does not grade routine review volume or referee/team win records as suspicious',()=>{
  const {audit}=expectationsFixture();addExpectationCluster(audit,1);audit.reviewCandidates=Array.from({length:80},(_,i)=>({...audit.reviewCandidates[0],id:`p-${i}`,playId:`p-${i}`}));
  for(const team of audit.expectations!.teams)team.refereeHistory={games:20,meanPenalties:6,meanPenaltyYards:50,wins:20,losses:0,ties:0};
  expect(getGameVerdict(audit)).toMatchObject({rating:1,reviewCount:80});
 });
 it('requires a favorable outcome residual and a three-play cluster for the same winner at the top tier',()=>{
  const aligned=expectationsFixture({outcomeCount:5});addExpectationCluster(aligned.audit,3);
  const top=getGameVerdict(aligned.audit);expect(top.rating).toBe(5);expect(top.reasons[0]).toBe('GB beat its box-score expectation by 18.2 points; 3 penalties extended one GB drive.');expect(top.reasons[0].length).toBeLessThanOrEqual(105);
  const losingBenefit=expectationsFixture({outcomeCount:5,residual:18.2});addExpectationCluster(losingBenefit.audit,3);expect(getGameVerdict(losingBenefit.audit).rating).toBe(4);
  const oppositeCluster=expectationsFixture({outcomeCount:5});addExpectationCluster(oppositeCluster.audit,3,'NYJ');expect(getGameVerdict(oppositeCluster.audit).rating).toBe(4);
  const two=expectationsFixture({outcomeCount:5});addExpectationCluster(two.audit,2);expect(getGameVerdict(two.audit).rating).toBe(4);
  const penaltiesOnly=expectationsFixture({penaltyCount:5});addExpectationCluster(penaltiesOnly.audit,3);expect(getGameVerdict(penaltiesOnly.audit).rating).toBe(4);
 });
 it('does not call a tied result or a zero residual a winner-aligned extreme',()=>{
  const tied=expectationsFixture({outcomeCount:5});addExpectationCluster(tied.audit,3);tied.audit.profiles.forEach(p=>{p.pointsFor=20;p.pointsAgainst=20;});
  const outcome=tied.audit.expectations!.outcome;outcome.actualHomeMargin=0;outcome.expectedHomeMargin=18.2;outcome.coefficients!.intercept+=3;
  expect(getGameVerdict(tied.audit).rating).toBe(4);
  const zero=expectationsFixture({outcomeCount:805,residual:0});addExpectationCluster(zero.audit,3);expect(getGameVerdict(zero.audit).rating).toBe(4);
 });
 const corruptions:Record<string,(a:GameAudit)=>void>={
  'missing expectations':a=>{delete a.expectations;},
  'unknown audit version':a=>{a.version='under-review-game-audit-v6';},
  'unknown model version':a=>{a.expectations!.version='unrecognized';},
  'unknown reference version':a=>{a.expectations!.reference.version='unrecognized';},
  'missing provenance':a=>{a.expectations!.reference.sourceUrls=[];},
  'invalid source checksum':a=>{a.expectations!.reference.sourceChecksums[a.expectations!.reference.sourceUrls[0]]='bad';},
  'invalid reference checksum':a=>{a.expectations!.reference.checksum='bad';},
  'unsupported family':a=>{a.expectations!.outcome.status='unavailable';},
  'non-null supported reason':a=>{a.expectations!.outcome.reasonCode='insufficient_training';},
  'insufficient calibration':a=>{a.expectations!.outcome.calibrationGames=499;},
  'tail arithmetic':a=>{a.expectations!.outcome.tailProbability=.001;},
  'missing anomaly score':a=>{a.expectations!.outcome.anomalyScore=null;},
  'negative anomaly score':a=>{a.expectations!.outcome.anomalyScore=-1;},
  'future training year':a=>{a.expectations!.cutoff.trainingSeasons[4]=2026;},
  'short training window':a=>{a.expectations!.cutoff.trainingSeasons.pop();},
  'duplicate calibration year':a=>{a.expectations!.cutoff.calibrationSeasons[0]=2025;},
  'invalid team counterpart':a=>{a.expectations!.teams[0].opponent='DAL';},
  'invalid team actual':a=>{a.expectations!.teams[0].actual.penalties=999;},
  'incomplete penalty training':a=>{a.expectations!.teams.forEach(t=>{t.league.games=998;});},
  'team expected arithmetic':a=>{a.expectations!.teams[0].expected!.penalties+=1;},
  'team residual arithmetic':a=>{a.expectations!.teams[0].residual!.penaltyYards+=1;},
  'missing outcome fit':a=>{a.expectations!.outcome.coefficients=null;},
  'insufficient outcome fit':a=>{a.expectations!.outcome.trainingGames=499;},
  'outcome coefficient arithmetic':a=>{a.expectations!.outcome.coefficients!.yardsPer100+=1;},
  'outcome residual arithmetic':a=>{a.expectations!.outcome.residual=a.expectations!.outcome.residual!+1;},
  'outcome score arithmetic':a=>{a.expectations!.outcome.anomalyScore=a.expectations!.outcome.anomalyScore!+1;},
  'penalty unavailable method':a=>{a.expectations!.penalty.method='unavailable';},
  'missing penalty components':a=>{a.expectations!.penalty.components=[];},
  'duplicated penalty component':a=>{a.expectations!.penalty.components[0]={...a.expectations!.penalty.components[1]};},
  'component actual arithmetic':a=>{a.expectations!.penalty.components[0].actual+=1;},
  'component expected arithmetic':a=>{a.expectations!.penalty.components[0].expected+=1;},
  'component residual arithmetic':a=>{a.expectations!.penalty.components[0].residual+=1;},
  'component standardized arithmetic':a=>{a.expectations!.penalty.components[0].standardized+=1;},
  'component zero scale':a=>{a.expectations!.penalty.components[0].scale=0;},
  'family max arithmetic':a=>{a.expectations!.penalty.anomalyScore=a.expectations!.penalty.anomalyScore!+1;},
  'missing referee effect':a=>{a.expectations!.penalty.method='team_opponent_referee';},
  'unapplied referee effect':a=>{a.expectations!.referee.effect={penalties:1,penaltyYards:1};},
 };
 it.each(Object.entries(corruptions))('withholds a rating for %s before any cluster escalation',(name,mutate)=>{
  const {audit}=expectationsFixture({outcomeCount:5});addExpectationCluster(audit,3);mutate(audit);
  expect(getGameVerdict(audit),name).toMatchObject({rating:null,label:'Unrated',cluster:null,reasons:[]});
 });
 it('rejects an impossible rare tail for a zero absolute anomaly',()=>{
  const {audit}=expectationsFixture({outcomeCount:5,residual:0});expect(getGameVerdict(audit).rating).toBeNull();
 });
 it.each(['missing','conflict','schedule_only'] as const)('keeps the separately calibrated referee-free method with %s assignment',status=>{
  const {audit}=expectationsFixture({outcomeCount:5});audit.expectations!.referee.status=status;
  expect(getGameVerdict(audit).rating).toBe(4);
 });
 it('accepts real engine output with and without a referee adjustment',async()=>{
  const reference=await loadExpectationsReference();
  for(const referee of [null,'Carl Cheffers']){
   const {game,audit}=expectationsFixture();game.id='2026_99_GB_NYJ';audit.profiles.forEach(p=>{p.gameId=game.id;});game.providerData.referee=referee;audit.expectations=buildExpectations(game,audit.profiles,reference);
   expect(audit.expectations.status).toBe('supported');expect(audit.expectations.penalty.method).toBe(referee?'team_opponent_referee':'team_opponent');
   expect(getGameVerdict(audit).rating).not.toBeNull();
  }
 });
 it.each([1,2,3,4])('preserves saved v%i legacy ratings without mutating their evidence',version=>{
  const {audit}=expectationsFixture({outcomeCount:5});audit.version=`under-review-game-audit-v${version}`;
  const before=structuredClone(audit);expect(getGameVerdict(audit)).toMatchObject({rating:1,rulesVersion:'game-suspicion-v2'});expect(audit).toEqual(before);
 });
});
