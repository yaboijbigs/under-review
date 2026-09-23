import {beforeAll,describe,expect,it} from 'vitest';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildExpectations,loadExpectationsReference,canonicalReferee,expectationReferee,empiricalExpectationTail,EXPECTATIONS_VERSION,type LoadedExpectationsReference,type ExpectationsReference} from '../packages/core/src/expectations.js';
import type {Game,GameProfile} from '../packages/core/src/contracts.js';
import {gameExpectationsSchema} from '../packages/core/src/expectations-contracts.js';

let loaded:LoadedExpectationsReference,profiles:GameProfile[];
const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:17,awayScore:20,kickoffAt:'2026-09-20T17:00:00Z',providerData:{referee:'Scott Novak'}};
beforeAll(async()=>{loaded=await loadExpectationsReference();profiles=JSON.parse(await readFile('analytics/models/game-profile-validation.json','utf8')).profiles;});
const cloned=()=>structuredClone(loaded);
const close=(actual:number|null,expected:number)=>expect(actual).toBeCloseTo(expected,10);
describe('chronological expected-versus-actual model',()=>{
 it('reuses immutable fits only for freshly verified identical file bytes',async()=>{
  expect(await loadExpectationsReference()).toBe(loaded);
  const directory=await mkdtemp(join(tmpdir(),'under-review-expectations-'));const file=join(directory,'reference.json');
  try{const bytes=await readFile('packages/core/reference/expectations-reference.json');await writeFile(file,bytes);expect(await loadExpectationsReference(file)).toBe(loaded);
   const changed=JSON.parse(bytes.toString('utf8'));changed.notes.push('Distinct bytes must be revalidated.');await writeFile(file,JSON.stringify(changed));const next=await loadExpectationsReference(file);expect(next).not.toBe(loaded);expect(next.checksum).not.toBe(loaded.checksum);expect(await loadExpectationsReference(file)).toBe(next);
   await writeFile(file,'{"invalid":true}');await expect(loadExpectationsReference(file)).rejects.toThrow();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it('checksums the complete frozen reference and retains its source identities',async()=>{
  const bytes=await readFile('packages/core/reference/expectations-reference.json');expect(loaded.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));expect(loaded.reference.rows).toHaveLength(6947);
  expect(loaded.reference.sourceChecksums['https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv']).toBe('9a54dffc1ed36a4a36437e7b526b2ce142eff936134a3ccb620c56d8e0f4f38c');
  expect(Object.isFrozen(loaded.reference.rows)).toBe(true);
 });
 it('uses the verified GB–NYJ score, penalties, and correct home-perspective box score',()=>{
  const result=buildExpectations(game,profiles,loaded);expect(result.version).toBe(EXPECTATIONS_VERSION);expect(result.status).toBe('supported');expect(result.cutoff).toEqual({targetSeason:2026,trainingSeasons:[2021,2022,2023,2024,2025],calibrationSeasons:[2023,2024,2025]});
  expect(result.teams.find(t=>t.team==='GB')?.actual).toEqual({penalties:14,penaltyYards:133});expect(result.teams.find(t=>t.team==='NYJ')?.actual).toEqual({penalties:13,penaltyYards:156});
  expect(result.outcome.actualHomeMargin).toBe(-3);const c=result.outcome.coefficients!;close(result.outcome.expectedHomeMargin,c.intercept+c.yardsPer100*0.86+c.turnoverMargin);close(result.outcome.residual,-3-result.outcome.expectedHomeMargin!);
  expect(result.outcome.calibrationGames).toBe(816);expect(result.penalty.calibrationGames).toBeGreaterThanOrEqual(500);expect(result.penalty.components.map(c=>c.actual)).toEqual([27,289,-1,23]);
  expect(gameExpectationsSchema.safeParse(result).success).toBe(true);
 });
 it('reports exact denominators and the specified shrunken team/opponent/referee arithmetic',()=>{
  const result=buildExpectations(game,profiles,loaded);const prior=loaded.reference.rows.filter(r=>r.season>=2021&&r.season<=2025);
  expect(result.teams[0].league.games).toBe(prior.length*2);expect(result.referee.games).toBe(81);expect(result.referee.home.games).toBe(81);expect(result.referee.away.games).toBe(81);
  close(result.referee.meanTotalPenalties,result.referee.home.meanPenalties!+result.referee.away.meanPenalties!);
  for(const team of result.teams){for(const field of ['penalties','penaltyYards'] as const){const key=field==='penalties'?'meanPenalties':'meanPenaltyYards',league=team.league[key]!;
   const own=(team.teamHistory[key]!*team.teamHistory.games+20*league)/(team.teamHistory.games+20),drawn=(team.opponentDrawn[key]!*team.opponentDrawn.games+20*league)/(team.opponentDrawn.games+20);
   close(team.expected![field],league+0.5*(own-league)+0.5*(drawn-league)+result.referee.effect![field]/2);
  }expect(team.refereeHistory.wins+team.refereeHistory.losses+team.refereeHistory.ties).toBe(team.refereeHistory.games);}
 });
 it('uses a maximum penalty-family statistic rather than adding correlated count and yard signals',()=>{
  const result=buildExpectations(game,profiles,loaded),components=result.penalty.components;
  close(result.penalty.anomalyScore,Math.max(...components.map(c=>Math.abs(c.standardized))));expect(result.penalty.anomalyScore).toBeLessThan(components.reduce((sum,c)=>sum+Math.abs(c.standardized),0));
  close(result.penalty.tailProbability,(result.penalty.atLeastAsUnusual+1)/(result.penalty.calibrationGames+1));close(result.outcome.tailProbability,(result.outcome.atLeastAsUnusual+1)/(result.outcome.calibrationGames+1));
 });
 it('does not use any current/future rows or the target outcome in historical fitting/calibration',()=>{
  const before=buildExpectations(game,profiles,loaded),changed=cloned();
  for(const season of [2026,2027,2035])changed.reference.rows.push({...changed.reference.rows[0],gameId:`${season}_01_FAKE_NOPE`,season,homeScore:999,awayScore:0,homePenalties:999,awayPenaltyYards:9999});
  expect(buildExpectations(game,profiles,changed)).toEqual(before);
  const changedScore={...game,homeScore:18},changedProfiles=profiles.map(p=>p.team==='NYJ'?{...p,pointsFor:18}:{...p,pointsAgainst:18});const newResult=buildExpectations(changedScore,changedProfiles,loaded);
  expect(newResult.outcome.coefficients).toEqual(before.outcome.coefficients);expect(newResult.outcome.expectedHomeMargin).toBe(before.outcome.expectedHomeMargin);expect(newResult.outcome.actualHomeMargin).toBe(-2);expect(newResult.outcome.calibrationGames).toBe(before.outcome.calibrationGames);
 });
 it('does not use a later season when estimating an earlier target',()=>{
  const sample=loaded.reference.rows.find(r=>r.season===2022)!;const target:Game={...game,id:sample.gameId,season:sample.season,homeTeam:sample.homeTeam,awayTeam:sample.awayTeam,homeScore:sample.homeScore,awayScore:sample.awayScore,providerData:{}};
  const pair=toProfiles(sample),before=buildExpectations(target,pair,loaded),changed=cloned();changed.reference.rows=changed.reference.rows.map(row=>row.season>=2022?{...row,homeYards:9999,homePenalties:999,homeScore:999}:row);
  expect(buildExpectations(target,pair,changed)).toEqual(before);
 });
 it('calibrates each historical game with its own earlier five seasons rather than the target fit',()=>{
  const target=buildExpectations(game,profiles,loaded),penalties:number[]=[],outcomes:number[]=[];
  for(const row of loaded.reference.rows.filter(row=>row.season>=2023&&row.season<=2025)){
   const historical=buildExpectations({...game,id:row.gameId,season:row.season,homeTeam:row.homeTeam,awayTeam:row.awayTeam,homeScore:row.homeScore,awayScore:row.awayScore,providerData:{}},toProfiles(row),loaded);
   expect(historical.cutoff.trainingSeasons.at(-1)).toBe(row.season-1);
   if(historical.penalty.method==='team_opponent_referee'&&historical.penalty.anomalyScore!==null)penalties.push(historical.penalty.anomalyScore);
   if(historical.outcome.anomalyScore!==null)outcomes.push(historical.outcome.anomalyScore);
  }
  expect(target.penalty.calibrationGames).toBe(penalties.length);expect(target.penalty.atLeastAsUnusual).toBe(penalties.filter(value=>value>=target.penalty.anomalyScore!-1e-12).length);
  expect(target.outcome.calibrationGames).toBe(outcomes.length);expect(target.outcome.atLeastAsUnusual).toBe(outcomes.filter(value=>value>=target.outcome.anomalyScore!-1e-12).length);
 });
 it('returns unavailable tails with fewer than 500 genuinely out-of-season calibration games',()=>{
  const changed=cloned();changed.reference.rows=changed.reference.rows.filter(row=>row.season!==2023&&row.season!==2024);
  const result=buildExpectations(game,profiles,changed);expect(result.penalty.status).toBe('unavailable');expect(result.outcome.status).toBe('unavailable');expect(result.outcome.tailProbability).toBeNull();
  expect(empiricalExpectationTail(5,Array(499).fill(3))).toMatchObject({status:'unavailable',tailProbability:null,calibrationGames:499});
  expect(empiricalExpectationTail(5,Array(500).fill(3))).toMatchObject({status:'supported',atLeastAsUnusual:0,tailProbability:1/501});
  expect(empiricalExpectationTail(3,Array(500).fill(3))).toMatchObject({tailProbability:1,atLeastAsUnusual:500});
 });
 it.each(['missing-profile','wrong-score','wrong-opponent','negative-count','missing-count','missing-yards','missing-turnovers','postseason','future-season'])('fails closed for %s while retaining independently supported families',condition=>{
  let target={...game},pair=structuredClone(profiles);if(condition==='missing-profile')pair.pop();if(condition==='wrong-score')pair[0].pointsFor=99;if(condition==='wrong-opponent')pair[0].opponent='KC';if(condition==='negative-count')pair[0].penalties=-1;if(condition==='missing-count')pair[0].penalties=null;if(condition==='missing-yards'){pair[0].totalYards=null;pair[1].opponentYards=null;}if(condition==='missing-turnovers'){pair[0].turnoverMargin=null;pair[1].turnoverMargin=null;}if(condition==='postseason')target.gameType='SB';if(condition==='future-season'){target={...target,id:'2027_02_GB_NYJ',season:2027};pair=pair.map(p=>({...p,gameId:target.id,season:2027}));}
  if(condition==='negative-count'){expect(()=>buildExpectations(target,pair,loaded)).toThrow();return;}
  const result=buildExpectations(target,pair,loaded);if(condition==='missing-count'){expect(result.penalty.tailProbability).toBeNull();expect(result.outcome.status).toBe('supported');}else if(condition==='missing-yards'||condition==='missing-turnovers'){expect(result.outcome.tailProbability).toBeNull();expect(result.penalty.status).toBe('supported');}else{expect(result.penalty.tailProbability).toBeNull();expect(result.outcome.tailProbability).toBeNull();}
 });
 it('merges only explicit referee aliases and preserves conflicting assignments as unavailable effects',()=>{
  expect(canonicalReferee(' Ron Torbert ',loaded.reference)).toBe('Ronald Torbert');expect(canonicalReferee('Scott Novac',loaded.reference)).toBe('Scott Novac');
  const aliases=buildExpectations({...game,providerData:{referee:'Ron Torbert'}},profiles,loaded);const canonical=buildExpectations({...game,providerData:{referee:'Ronald Torbert'}},profiles,loaded);expect(aliases).toEqual(canonical);
  expect(expectationReferee({id:'2023_05_GB_LV',season:2023,providerData:{referee:'Alan Eck'}},loaded.reference)).toMatchObject({status:'conflict',canonicalId:null});
  const changed=cloned();changed.reference.assignments=changed.reference.assignments.map(row=>row.gameId===game.id?{...row,status:'conflict' as const,canonicalId:null}:row);
  const result=buildExpectations(game,profiles,changed);expect(result.referee).toMatchObject({status:'conflict',effect:null,games:0});expect(result.penalty.method).toBe('team_opponent');expect(result.penalty.status).toBe('supported');
 });
 it('excludes conflicting assignment games from referee cohorts, not league/team samples',()=>{
  const before=buildExpectations(game,profiles,loaded),changed=cloned();const target=changed.reference.assignments.find(a=>a.season===2025&&a.name==='Scott Novak'&&a.status!=='conflict')!;target.status='conflict';target.canonicalId=null;
  const after=buildExpectations(game,profiles,changed);expect(after.referee.games).toBe(before.referee.games-1);expect(after.teams[0].league).toEqual(before.teams[0].league);
 });
 it('uses separate base calibration for a referee with sparse or absent history',()=>{
  const unknown=buildExpectations({...game,providerData:{referee:'New official'}},profiles,loaded);expect(unknown.referee).toMatchObject({status:'schedule_only',games:0,effect:null,reasonCode:'insufficient_referee_history'});expect(unknown.penalty.method).toBe('team_opponent');expect(unknown.penalty.calibrationGames).toBe(816);
  const changed=cloned();changed.reference.assignments=changed.reference.assignments.map(a=>a.season<2026&&a.name==='Scott Novak'?{...a,status:'missing' as const,name:null,canonicalId:null}:a);expect(buildExpectations(game,profiles,changed).referee.effect).toBeNull();
 });
 it('normalizes franchise codes for committed/opponent-drawn histories without changing display names',()=>{
  const row=loaded.reference.rows.find(r=>r.season===2025&&(r.homeTeam==='LV'||r.awayTeam==='LV'))!;const pair=toProfiles(row).map(p=>({...p,gameId:'2026_01_OAK_DEMO',season:2026,team:p.team==='LV'?'OAK':p.team,opponent:p.opponent==='LV'?'OAK':p.opponent}));
  const target={...game,id:'2026_01_OAK_DEMO',homeTeam:row.homeTeam==='LV'?'OAK':row.homeTeam,awayTeam:row.awayTeam==='LV'?'OAK':row.awayTeam,homeScore:row.homeScore,awayScore:row.awayScore,providerData:{}};
  const result=buildExpectations(target,pair,loaded);expect(result.teams.find(t=>t.team==='OAK')!.teamHistory.games).toBe(85);
 });
});
function toProfiles(row:ExpectationsReference['rows'][number]):GameProfile[]{return [false,true].map(home=>({gameId:row.gameId,season:row.season,team:home?row.homeTeam:row.awayTeam,opponent:home?row.awayTeam:row.homeTeam,pointsFor:home?row.homeScore:row.awayScore,pointsAgainst:home?row.awayScore:row.homeScore,totalYards:home?row.homeYards:row.awayYards,opponentYards:home?row.awayYards:row.homeYards,penalties:home?row.homePenalties:row.awayPenalties,penaltyYards:home?row.homePenaltyYards:row.awayPenaltyYards,turnoverMargin:row.homeTurnoverMargin===null?null:row.homeTurnoverMargin*(home?1:-1),nonOffensiveTouchdowns:null}));}
