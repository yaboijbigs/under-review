import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Game, GameAudit, GameProfile, GameProfileReference } from '../packages/core/src/contracts.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { getGameVerdict, teamName, SUSPICION_RULES_VERSION, SUSPICION_SCALE } from '../packages/core/src/consumer-summary.js';

const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:23,kickoffAt:null,providerData:{}};
const winner:GameProfile={gameId:game.id,season:2026,team:'GB',opponent:'NYJ',pointsFor:23,pointsAgainst:20,totalYards:199,opponentYards:350,penalties:13,penaltyYards:133,turnoverMargin:-1,nonOffensiveTouchdowns:1};
const loser:GameProfile={...winner,team:'NYJ',opponent:'GB',pointsFor:20,pointsAgainst:23,totalYards:350,opponentYards:199,penalties:4,penaltyYards:30,turnoverMargin:1};
function audit(wins=1,n=20){
 const reference:GameProfileReference={schemaVersion:1,version:'test',startSeason:2025,endSeason:2025,sourceUrls:[],sourceChecksums:{},notes:[],rows:Array.from({length:n},(_,i)=>({...winner,gameId:`2025_${i}_GB_NYJ`,season:2025,pointsFor:i<wins?23:10}))};
 return buildGameAudit({game,profiles:[winner,loser],reference,referenceChecksum:'a'.repeat(64)});
}
function addCluster(a:GameAudit,n:number,team='GB',drive=19){
 a.context=a.context.filter(context=>context.kind==='drive_extending_penalties');
 const opponent=team==='GB'?'NYJ':'GB';const playIds=Array.from({length:n},(_,i)=>`${drive}-${i}`);
 a.context.push({kind:'drive_extending_penalties',team,playIds,text:'Repeated defensive first-down penalties'});
 a.reviewCandidates.push(...playIds.map(playId=>({id:playId,playId,quarter:4,clock:'06:49',description:'Defensive penalty',team,priority:'high' as const,observedWpSwing:null,existingEventId:null,reasons:[`Defensive penalty on ${opponent} awarded ${team} a first down on third down; call correctness requires review.`,`${n} defensive-penalty first downs on third or fourth down occurred on ${team} drive ${drive}; review the sequence together.`]})));
}

describe('consumer game verdicts',()=>{
 it.each([[1,'sus'],[2,'hmm'],[3,'fair']] as const)('uses the existing thresholds with %i wins', (wins,level)=>{
  const result=getGameVerdict(audit(wins));expect(result.level).toBe(level);
  if(level!=='fair')expect(result.comparison).toMatchObject({wins,matchingGames:20,winRate:wins/20});
 });
 it('states real outlier evidence without treating a tiny sample as proof',async()=>{
  const reference=JSON.parse(await readFile('analytics/models/game-profiles.json','utf8')) as GameProfileReference;
  const {profiles}=JSON.parse(await readFile('analytics/models/game-profile-validation.json','utf8')) as {profiles:GameProfile[]};
  const gb=profiles.find(p=>p.team==='GB')!;
  const result=getGameVerdict(buildGameAudit({game:{...game,awayScore:gb.pointsFor,homeScore:gb.pointsAgainst},profiles,reference,referenceChecksum:'a'.repeat(64)}));
  expect(result.label).toBe('Sus');expect(result.comparison).toMatchObject({wins:6,matchingGames:414});
  expect(result.reasons.join(' ')).toContain('Green Bay Packers won');expect(result.reasons.join(' ')).toContain('133 yards');
  expect(result.evidenceNote).toContain('not the odds');
 });
 it('keeps a tiny winless historical group limited and does not show a win rate',()=>{
  const result=getGameVerdict(audit(0,14));expect(result.level).toBe('limited');expect(result.comparison?.winRate).toBeNull();expect(result.summary).toContain('14 matching games');
 });
 it('separates a key-play flag from result rarity',()=>{
  const a=audit(3);a.reviewCandidates=[{id:'p',playId:'1',quarter:4,clock:'00:30',description:'Penalty',team:'GB',reasons:['Late penalty'],priority:'medium',observedWpSwing:.1,existingEventId:null}];
  expect(getGameVerdict(a)).toMatchObject({level:'debatable',rating:2,reviewCount:1});
  a.profiles[0].penaltyYards=null;
  expect(getGameVerdict(a)).toMatchObject({level:'limited',reviewCount:1});
 });
 it.each(['checksum','rate','count','future','condition','score','turnovers','yardage'] as const)('does not convert invalid %s evidence into a normal or unusual verdict',kind=>{
  const a=audit();
  if(kind==='checksum')a.reference.checksum=null;
  if(kind==='rate')a.flags[0].reference.winRate=.9;
  if(kind==='count')a.flags[0].reference.wins=-1;
  if(kind==='future')a.reference.endSeason=2026;
  if(kind==='condition')a.flags[0].conditions=['Unknown'];
  if(kind==='score')a.profiles.forEach(p=>p.pointsFor=null);
  if(kind==='turnovers')a.profiles.find(p=>p.team==='GB')!.turnoverMargin=-.5;
  if(kind==='yardage')a.profiles.find(p=>p.team==='GB')!.totalYards=199.5;
  expect(getGameVerdict(a).level).toBe('limited');
 });
 it('distinguishes a report without a verdict from a game awaiting analysis',()=>{
  expect(getGameVerdict(null)).toMatchObject({level:'limited',shortLabel:'Unrated',rating:null});
  expect(getGameVerdict(null,false)).toMatchObject({level:'awaiting'});
 });
 it('does not label a tie as an ordinary win',()=>{
  const a=audit();a.flags=[];a.profiles.forEach(p=>{p.pointsFor=20;p.pointsAgainst=20;});
  expect(getGameVerdict(a)).toMatchObject({level:'limited'});expect(getGameVerdict(a).summary).toContain('tie');
 });
 it('recognizes canonical and legacy Rams abbreviations',()=>{expect(teamName('LA')).toBe('Los Angeles Rams');expect(teamName('LAR')).toBe(teamName('LA'));});
 it.each([[2,'hmm',3],[3,'sus',4],[4,'sus',4]] as const)('rates a validated %i-play cluster as %s', (n,level,rating)=>{
  const a=audit(3);addCluster(a,n);expect(getGameVerdict(a)).toMatchObject({level,rating,cluster:{team:'GB',playIds:a.context[0].playIds},rulesVersion:SUSPICION_RULES_VERSION});
 });
 it('requires the historical outlier and cluster to benefit the same winner for the top tier',()=>{
  const a=audit();addCluster(a,3);expect(getGameVerdict(a)).toMatchObject({level:'extreme',rating:5,label:'RIGGED?'});
  const opposite=audit();addCluster(opposite,3,'NYJ');expect(getGameVerdict(opposite)).toMatchObject({level:'sus',rating:4});
  const moderate=audit(2);addCluster(moderate,3);expect(getGameVerdict(moderate).level).toBe('sus');
  const short=audit();addCluster(short,2);expect(getGameVerdict(short).level).toBe('sus');
 });
 it('does not accumulate unrelated drives or duplicate contexts',()=>{
  const a=audit(3);addCluster(a,2,'GB',18);addCluster(a,2,'GB',19);a.context.push({...a.context[0]});
  expect(getGameVerdict(a)).toMatchObject({level:'hmm',rating:3});
 });
 it.each(['duplicate','missing','offense','unknown-team','reason','drive','kind','conflicting-candidate'] as const)('rejects an invalid %s cluster without inflating the rating',kind=>{
  const a=audit(3);addCluster(a,3);
  if(kind==='duplicate')a.context[0].playIds=['19-0','19-0','19-0'];
  if(kind==='missing')a.context[0].playIds[2]='absent';
  if(kind==='offense')a.reviewCandidates[0].team='NYJ';
  if(kind==='unknown-team')a.context[0].team='UNKNOWN';
  if(kind==='reason')a.reviewCandidates[0].reasons[0]='Late penalty';
  if(kind==='drive')a.reviewCandidates[0].reasons[1]=a.reviewCandidates[0].reasons[1].replace('drive 19','drive 20');
  if(kind==='kind')a.context[0].kind='scoring';
  if(kind==='conflicting-candidate')a.reviewCandidates.push({...a.reviewCandidates[0],team:'NYJ'});
  expect(getGameVerdict(a)).toMatchObject({level:'debatable',rating:2,cluster:null});
 });
 it('counts distinct plays rather than duplicated rows when the underlying cluster is valid',()=>{
  const a=audit(3);addCluster(a,2);a.context[0].playIds.push(a.context[0].playIds[0]);a.reviewCandidates.push({...a.reviewCandidates[0]});
  expect(getGameVerdict(a)).toMatchObject({level:'hmm',cluster:{playIds:['19-0','19-1']}});
 });
 it('never escalates on routine candidate volume alone',()=>{
  const a=audit(3);a.reviewCandidates=Array.from({length:100},(_,i)=>({id:`p${i}`,playId:`${i}`,quarter:4,clock:null,description:'Review candidate',team:'GB',reasons:['Late penalty'],priority:'high',observedWpSwing:.9,existingEventId:null}));
  expect(getGameVerdict(a)).toMatchObject({level:'debatable',rating:2,reviewCount:100});
 });
 it.each(['opponent-score','opponent-yards','opponent-turnovers','season','missing-stat','checksum'] as const)('applies %s coverage checks before even a top-tier signal',kind=>{
  const a=audit();addCluster(a,3);
  if(kind==='opponent-score')a.profiles[1].pointsAgainst=24;
  if(kind==='opponent-yards')a.profiles[1].opponentYards=200;
  if(kind==='opponent-turnovers')a.profiles[1].turnoverMargin=2;
  if(kind==='season')a.profiles[1].season=2025;
  if(kind==='missing-stat')a.profiles[1].penalties=null;
  if(kind==='checksum')a.reference.checksum=null;
  expect(getGameVerdict(a)).toMatchObject({level:'limited',rating:null,cluster:null});
 });
 it.each([[1,19,'limited'],[1,20,'sus'],[5,100,'sus'],[6,100,'hmm'],[10,100,'hmm'],[11,100,'fair']] as const)('enforces historical boundaries %i/%i', (wins,n,level)=>expect(getGameVerdict(audit(wins,n)).level).toBe(level));
 it('uses the same ordered, versioned editorial labels everywhere',()=>{
  expect(SUSPICION_SCALE.map(t=>t.label)).toEqual(['Fair','Debatable','Hmm','Sus','RIGGED?']);
  expect(SUSPICION_SCALE.map(t=>t.rating)).toEqual([1,2,3,4,5]);
  expect(getGameVerdict(audit(3)).definition).toContain('within the checks');
 });
});
