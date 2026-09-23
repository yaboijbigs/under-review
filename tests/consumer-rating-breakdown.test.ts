import {describe,expect,it} from 'vitest';
import {getGameRatingBreakdown,getGameVerdict} from '../packages/core/src/consumer-summary.js';
import {addExpectationCluster,expectationMarket,expectationsFixture} from './consumer-expectations.fixture.js';

describe('consumer rating calculation disclosure',()=>{
 it.each([[7,4],[8,3],[25,3],[26,2],[52,2],[53,1]] as const)('matches the existing outcome threshold for %i comparisons',(outcomeCount,rating)=>{
  const {audit}=expectationsFixture({outcomeCount}),before=structuredClone(audit),result=getGameRatingBreakdown(audit);
  expect(result).toMatchObject({status:'available',rating,label:getGameVerdict(audit).label,rulesVersion:'game-suspicion-v3'});
  expect(result.families.map(f=>f.id)).toEqual(['outcome','penalty','spread','drive']);
  expect(result.families[0]).toMatchObject({eligibleRating:rating,tailProbability:(outcomeCount+1)/806});expect(result.families[0].adjustedTailProbability).toBeCloseTo(Math.min(1,3*(outcomeCount+1)/806),14);
  expect(result.families[0].evidence.join(' ')).toContain('actual result: GB by 3');expect(result.summary).toContain(`(${rating}/5):`);
  expect(audit).toEqual(before);
 });
 it('takes the highest eligible tier without adding correlated families',()=>{
  const {audit}=expectationsFixture({outcomeCount:40,penaltyCount:40});audit.market=expectationMarket(40);
  const result=getGameRatingBreakdown(audit);expect(result.families.map(f=>f.eligibleRating)).toEqual([2,2,2,1]);expect(result.rating).toBe(2);
  expect(result.families[1].evidence[0]).toBe('NYJ minus GB penalty-yard difference: -103 versus 0.0 expected.');
  expect(result.families[1].evidence[1]).toContain('four related penalty checks is counted once');
  expect(result.combinationRule).toContain('signals are not added');
 });
 it('uses the same add-one spread tail and Hmm cap as the verdict',()=>{
  const {audit}=expectationsFixture();audit.market=expectationMarket(0);
  const result=getGameRatingBreakdown(audit),spread=result.families.find(f=>f.id==='spread')!;
  expect(spread).toMatchObject({status:'eligible',eligibleRating:3,eligibleLabel:'Hmm',tailProbability:1/806,adjustedTailProbability:3/806});
  expect(spread.evidence[0]).toContain('difference was 27 points');expect(result.rating).toBe(3);
  expect(result.thresholds).toEqual([{rating:2,label:'Debatable',adjustedTailAtMost:.20},{rating:3,label:'Hmm',adjustedTailAtMost:.10},{rating:4,label:'Sus',adjustedTailAtMost:.03}]);
  expect(result.notes.join(' ')).toContain('Spread alone is capped at Hmm');
 });
 it('does not give missing or invalid spread evidence a Fair badge or a numerical rarity',()=>{
  for(const corrupt of [false,true]){
   const {audit}=expectationsFixture({outcomeCount:7});if(corrupt){audit.market=expectationMarket(0);audit.market.absoluteError=99;}
   const result=getGameRatingBreakdown(audit);expect(result.rating).toBe(4);expect(result.families[2]).toMatchObject({status:'unavailable',eligibleRating:null,eligibleLabel:null,tailProbability:null,adjustedTailProbability:null});
   expect(result.families[2].evidence.join(' ')).toContain('missing or inconsistent');
  }
 });
 it.each([[2,3],[3,4]] as const)('explains %i verified drive penalties without inventing a tail',(count,rating)=>{
  const {audit}=expectationsFixture();addExpectationCluster(audit,count);
  const result=getGameRatingBreakdown(audit);expect(result.rating).toBe(rating);expect(result.families[3]).toMatchObject({eligibleRating:rating,tailProbability:null,adjustedTailProbability:null});
  expect(result.families[3].evidence[0]).toBe(`${count} defensive penalties gave GB first downs on third or fourth down during one drive.`);
  expect(result.corroboration).toMatchObject({eligible:false,winner:'GB',winnerDrivePenalties:count});
 });
 it('does not treat malformed drive evidence as a qualifying cluster',()=>{
  const {audit}=expectationsFixture();addExpectationCluster(audit,3);audit.reviewCandidates[0].team='NYJ';
  const result=getGameRatingBreakdown(audit);expect(result.rating).toBe(1);expect(result.families[3]).toMatchObject({eligibleRating:1,eligibleLabel:'Fair'});expect(result.families[3].evidence[0]).toContain('No qualifying');
 });
 it('explains the additional same-winner combination that makes tier five eligible',()=>{
  const {audit}=expectationsFixture({outcomeCount:5});addExpectationCluster(audit,3);
  const result=getGameRatingBreakdown(audit);expect(result.rating).toBe(5);expect(result.families.every(f=>(f.eligibleRating??0)<5)).toBe(true);
  expect(result.corroboration).toMatchObject({eligible:true,winner:'GB',outcomeFavoredTeam:'GB',winnerDrivePenalties:3});
  expect(result.notes.join(' ')).toContain('same winner’s drive');
  const losing=expectationsFixture({outcomeCount:5,residual:18.2});addExpectationCluster(losing.audit,3);
  expect(getGameRatingBreakdown(losing.audit)).toMatchObject({rating:4,corroboration:{eligible:false,outcomeFavoredTeam:'NYJ',explanation:'The outcome deviation does not favor the winning team.'}});
 });
 it('explains that a tie cannot satisfy the winner-specific tier-five rule',()=>{
  const {audit}=expectationsFixture({outcomeCount:5});addExpectationCluster(audit,3);audit.profiles.forEach(p=>{p.pointsFor=20;p.pointsAgainst=20;});
  const outcome=audit.expectations!.outcome;outcome.actualHomeMargin=0;outcome.expectedHomeMargin=18.2;outcome.coefficients!.intercept+=3;
  expect(getGameRatingBreakdown(audit)).toMatchObject({status:'available',rating:4,corroboration:{eligible:false,winner:null,explanation:'A tied game has no winner, so the RIGGED? combination cannot apply.'}});
 });
 it('keeps referee/team win records contextual without creating an extra scoring family',()=>{
  const {audit}=expectationsFixture(),before=getGameRatingBreakdown(audit);
  for(const team of audit.expectations!.teams)team.refereeHistory={games:20,meanPenalties:6,meanPenaltyYards:50,wins:20,losses:0,ties:0};
  expect(getGameRatingBreakdown(audit)).toEqual(before);expect(before.notes.join(' ')).toContain('win/loss/tie records under that referee are context only');
 });
 it.each(['missing','unknown','arithmetic','unsupported'] as const)('does not fabricate a calculation for %s evidence',kind=>{
  const {audit}=expectationsFixture({outcomeCount:5});addExpectationCluster(audit,3);
  if(kind==='missing')delete audit.expectations;if(kind==='unknown')audit.version='under-review-game-audit-v99';if(kind==='arithmetic')audit.expectations!.penalty.components[0].expected+=1;if(kind==='unsupported')audit.expectations!.outcome.status='unavailable';
  expect(getGameRatingBreakdown(audit)).toMatchObject({status:'unavailable',rating:null,families:[],thresholds:[],corroboration:null});
 });
 it('handles absent audits and preserves legacy ratings without retroactive v3 arithmetic',()=>{
  expect(getGameRatingBreakdown(null)).toMatchObject({status:'unavailable',rating:null,families:[]});expect(getGameRatingBreakdown(undefined)).toMatchObject({status:'unavailable',rating:null,families:[]});
  const {audit}=expectationsFixture();audit.version='under-review-game-audit-v4';const result=getGameRatingBreakdown(audit);
  expect(result).toMatchObject({status:'legacy',rulesVersion:'game-suspicion-v2',rating:getGameVerdict(audit).rating,families:[],thresholds:[],corroboration:null});expect(result.summary).toContain('earlier rating rules');
 });
});
