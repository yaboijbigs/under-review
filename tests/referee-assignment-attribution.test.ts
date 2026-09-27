import {beforeAll,describe,expect,it} from 'vitest';
import {buildExpectations,expectationReferee,loadExpectationsReference,type LoadedExpectationsReference} from '../packages/core/src/expectations.js';
import {refereeAssignmentSchema,type RefereeAssignment} from '../packages/core/src/referee-assignment-contracts.js';
import {gameExpectationsSchema} from '../packages/core/src/expectations-contracts.js';
import {getGameVerdict} from '../packages/core/src/consumer-summary.js';
import {expectationsFixture} from './consumer-expectations.fixture.js';

let loaded:LoadedExpectationsReference;
beforeAll(async()=>{loaded=await loadExpectationsReference();});
function fixture(){
 const {game,audit}=expectationsFixture();game.id='2026_03_GB_NYJ';game.week=3;audit.profiles.forEach(profile=>{profile.gameId=game.id;});
 const assignment:RefereeAssignment={gameId:game.id,season:2026,week:3,name:'Scott Novak',status:'reported',sources:[{provider:'football-zebras',name:'Scott Novak',url:'https://www.footballzebras.com/2026/09/week-3-referee-assignments-2026/',snapshotId:`sha256:${'a'.repeat(64)}`,checksum:'a'.repeat(64)}]};
 return {game,audit,assignment};
}

describe('published pregame referee attribution',()=>{
 it('uses the same existing adjustment with attributed pregame data without modifying nflverse game bytes',()=>{
  const {game,audit,assignment}=fixture(),before=structuredClone(game);
  const reported=buildExpectations(game,audit.profiles,loaded,assignment);
  const schedule=buildExpectations({...game,providerData:{referee:'Scott Novak'}},audit.profiles,loaded);
  expect(reported.referee).toMatchObject({status:'reported',name:'Scott Novak',canonicalId:'scott-novak',games:81,assignment});
  expect(reported.referee.effect).toEqual(schedule.referee.effect);expect(reported.penalty).toEqual(schedule.penalty);expect(reported.outcome).toEqual(schedule.outcome);
  expect(reported.penalty.method).toBe('team_opponent_referee');expect(game).toEqual(before);expect(reported.reference).toEqual(schedule.reference);
  audit.expectations=reported;expect(getGameVerdict(audit).rating).not.toBeNull();expect(gameExpectationsSchema.safeParse(reported).success).toBe(true);
 });
 it('accepts Sharp alone as an attributed fallback',()=>{
  const {game,audit,assignment}=fixture();assignment.sources=[{...assignment.sources[0],provider:'sharp-football',url:'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/'}];
  const result=buildExpectations(game,audit.profiles,loaded,assignment);expect(result.referee).toMatchObject({status:'reported',name:'Scott Novak',assignment});expect(result.penalty.method).toBe('team_opponent_referee');
 });
 it('compares explicit aliases consistently while preserving publisher spelling in source evidence',()=>{
  const {game,audit,assignment}=fixture();assignment.name='Ron Torbert';assignment.sources[0].name='Ron Torbert';assignment.sources.push({...assignment.sources[0],provider:'sharp-football',name:'Ronald Torbert',url:'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/'});
  audit.expectations=buildExpectations(game,audit.profiles,loaded,assignment);
  expect(audit.expectations.referee).toMatchObject({status:'reported',name:'Ronald Torbert',canonicalId:'ronald-torbert',assignment:{name:'Ronald Torbert'}});
  expect(audit.expectations.referee.assignment?.sources.map(source=>source.name)).toEqual(['Ron Torbert','Ronald Torbert']);expect(getGameVerdict(audit).rating).not.toBeNull();
 });
 it('retains the later schedule authority when matching assignments are reconciled',()=>{
  const {game,assignment}=fixture();game.providerData.referee='Scott Novak';
  expect(expectationReferee(game,loaded.reference,assignment)).toMatchObject({status:'schedule_only',scheduleName:'Scott Novak',assignment});
  const reference=structuredClone(loaded.reference);reference.assignments.push({gameId:game.id,season:game.season,name:'Scott Novak',canonicalId:'scott-novak',status:'verified',scheduleName:null,officialName:'Scott Novak',officialId:'test-ref',officialEra:'test'});
  expect(expectationReferee({...game,providerData:{}},reference,assignment)).toMatchObject({status:'verified',officialName:'Scott Novak',assignment});
 });
 it.each(['publishers','officials','mislabelled-reported-source'] as const)('excludes the referee effect for disagreeing %s without blocking the game rating',kind=>{
  const {game,audit,assignment}=fixture();let reference=loaded;
  if(kind==='publishers'){assignment.status='conflict';assignment.name=null;assignment.sources.push({...assignment.sources[0],provider:'sharp-football',name:'Shawn Smith',url:'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/'});}
  if(kind==='officials'){reference=structuredClone(loaded);reference.reference.assignments.push({gameId:game.id,season:game.season,name:'Shawn Smith',canonicalId:'shawn-smith',status:'verified',scheduleName:null,officialName:'Shawn Smith',officialId:'test-ref',officialEra:'test'});}
  if(kind==='mislabelled-reported-source')assignment.sources[0].name='Shawn Smith';
  audit.expectations=buildExpectations(game,audit.profiles,reference,assignment);
  expect(audit.expectations.referee).toMatchObject({status:'conflict',canonicalId:null,effect:null,games:0});expect(audit.expectations.penalty.method).toBe('team_opponent');expect(getGameVerdict(audit).rating).not.toBeNull();
 });
 it.each(['single-publisher','stale-Sharp','verified-official'] as const)('uses the later nflverse assignment to resolve %s while preserving publisher claims',kind=>{
  const {game,audit,assignment}=fixture();let reference=loaded;game.providerData.referee='Scott Novak';
  if(kind==='single-publisher'){assignment.name='Shawn Smith';assignment.sources[0].name='Shawn Smith';}
  else{assignment.name=null;assignment.status='conflict';assignment.sources.push({...assignment.sources[0],provider:'sharp-football',name:'Shawn Smith',url:'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/'});}
  if(kind==='verified-official'){reference=structuredClone(loaded);reference.reference.assignments.push({gameId:game.id,season:game.season,name:'Scott Novak',canonicalId:'scott-novak',status:'verified',scheduleName:null,officialName:'Scott Novak',officialId:'test-ref',officialEra:'test'});}
  audit.expectations=buildExpectations(game,audit.profiles,reference,assignment);
  const scheduleOnly=buildExpectations(game,audit.profiles,reference);
  expect(audit.expectations.referee).toMatchObject({name:'Scott Novak',status:kind==='verified-official'?'verified':'schedule_only',assignmentResolution:'nflverse',assignment});
  expect(audit.expectations.referee.effect).toEqual(scheduleOnly.referee.effect);expect(audit.expectations.penalty).toEqual(scheduleOnly.penalty);expect(getGameVerdict(audit).rating).not.toBeNull();
 });
 it.each(['schedule-official-disagreement','frozen-conflict'] as const)('preserves the internal %s guard even with current nflverse data',kind=>{
  const {game,audit,assignment}=fixture(),reference=structuredClone(loaded);game.providerData.referee=kind==='schedule-official-disagreement'?'Shawn Smith':'Scott Novak';
  reference.reference.assignments.push({gameId:game.id,season:game.season,name:'Scott Novak',canonicalId:kind==='frozen-conflict'?null:'scott-novak',status:kind==='frozen-conflict'?'conflict':'verified',scheduleName:null,officialName:'Scott Novak',officialId:'test-ref',officialEra:'test'});
  audit.expectations=buildExpectations(game,audit.profiles,reference,assignment);
  expect(audit.expectations.referee).toMatchObject({status:'conflict',effect:null,canonicalId:null});expect(audit.expectations.referee.assignmentResolution).toBeUndefined();expect(getGameVerdict(audit).rating).not.toBeNull();
 });
 it('does not use nflverse to excuse internally inconsistent publisher claims',()=>{
  const {game,audit,assignment}=fixture();game.providerData.referee='Scott Novak';assignment.sources[0].name='Shawn Smith';
  const result=buildExpectations(game,audit.profiles,loaded,assignment);expect(result.referee).toMatchObject({status:'conflict',effect:null});expect(result.referee.assignmentResolution).toBeUndefined();
 });
 it.each(['game','season','week','source-url','source-week','checksum','duplicate-provider','empty-sources'] as const)('fails closed for mismatched or invalid %s evidence without throwing',kind=>{
  const {game,audit,assignment}=fixture();
  if(kind==='game')assignment.gameId='2026_03_ATL_GB';if(kind==='season')assignment.season=2025;if(kind==='week')assignment.week=4;
  if(kind==='source-url')assignment.sources[0].url='not a URL';if(kind==='source-week')assignment.sources[0].url=assignment.sources[0].url.replace('week-3','week-2');
  if(kind==='checksum')assignment.sources[0].checksum='invalid';if(kind==='duplicate-provider')assignment.sources.push({...assignment.sources[0]});if(kind==='empty-sources')assignment.sources=[];
  for(const referee of [undefined,'Scott Novak']){
   audit.expectations=buildExpectations({...game,providerData:{referee}},audit.profiles,loaded,assignment);
   expect(audit.expectations.referee).toMatchObject({status:'conflict',canonicalId:null,effect:null,reasonCode:'invalid_referee_assignment'});expect(audit.expectations.referee.assignment).toBeUndefined();expect(audit.expectations.referee.assignmentResolution).toBeUndefined();expect(audit.expectations.penalty.method).toBe('team_opponent');expect(getGameVerdict(audit).rating).not.toBeNull();
  }
 });
 it('keeps the existing un-attributed report schema and numerical results compatible',()=>{
  const {game,audit}=fixture();const old=buildExpectations(game,audit.profiles,loaded);expect(old.referee.assignment).toBeUndefined();expect(old.referee.status).toBe('missing');expect(gameExpectationsSchema.parse(old)).toEqual(old);
 });
 it('retains the calibrated fallback when an assigned referee has insufficient history',()=>{
  const {game,audit,assignment}=fixture();assignment.name='New Referee';assignment.sources[0].name='New Referee';audit.expectations=buildExpectations(game,audit.profiles,loaded,assignment);
  expect(audit.expectations.referee).toMatchObject({status:'reported',name:'New Referee',effect:null,reasonCode:'insufficient_referee_history'});expect(audit.expectations.penalty.method).toBe('team_opponent');expect(getGameVerdict(audit).rating).not.toBeNull();
 });
 it.each(['missing-assignment','wrong-game','wrong-name','wrong-id','bad-checksum','conflicting-assignment'] as const)('withholds a forged reported adjustment with %s',kind=>{
  const {game,audit,assignment}=fixture();audit.expectations=buildExpectations(game,audit.profiles,loaded,assignment);const referee=audit.expectations.referee;
  if(kind==='missing-assignment')delete referee.assignment;if(kind==='wrong-game')referee.assignment!.gameId='2026_03_ATL_GB';if(kind==='wrong-name')referee.assignment!.name='Shawn Smith';if(kind==='wrong-id')referee.canonicalId='shawn-smith';if(kind==='bad-checksum')referee.assignment!.sources[0].checksum='invalid';if(kind==='conflicting-assignment'){referee.assignment!.status='conflict';referee.assignment!.name=null;}
  expect(getGameVerdict(audit).rating).toBeNull();
 });
 it.each(['missing-resolution','missing-assignment','wrong-game','wrong-season','bad-checksum','reported-status','wrong-id'] as const)('requires explicit validated nflverse resolution: %s',kind=>{
  const {game,audit,assignment}=fixture();game.providerData.referee='Scott Novak';assignment.status='conflict';assignment.name=null;assignment.sources.push({...assignment.sources[0],provider:'sharp-football',name:'Shawn Smith',url:'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/'});
  audit.expectations=buildExpectations(game,audit.profiles,loaded,assignment);const ref=audit.expectations.referee;
  if(kind==='missing-resolution')delete ref.assignmentResolution;if(kind==='missing-assignment')delete ref.assignment;if(kind==='wrong-game')ref.assignment!.gameId='2026_03_ATL_GB';if(kind==='wrong-season')ref.assignment!.season=2025;if(kind==='bad-checksum')ref.assignment!.sources[0].checksum='bad';if(kind==='reported-status')ref.status='reported';if(kind==='wrong-id')ref.canonicalId='shawn-smith';
  expect(getGameVerdict(audit).rating).toBeNull();
 });
 it.each(['https://www.footballzebras.com.evil.test/2026/09/week-3-referee-assignments-2026/','https://user@www.footballzebras.com/2026/09/week-3-referee-assignments-2026/','http://www.footballzebras.com/2026/09/week-3-referee-assignments-2026/','https://www.footballzebras.com/2026/09/week-3-referee-assignments-2026/?other=1'])('rejects noncanonical source URL %s',url=>{
  const {assignment}=fixture();assignment.sources[0].url=url;expect(refereeAssignmentSchema.safeParse(assignment).success).toBe(false);
 });
});
