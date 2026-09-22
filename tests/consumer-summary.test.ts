import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Game, GameProfile, GameProfileReference } from '../packages/core/src/contracts.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { getGameVerdict, teamName } from '../packages/core/src/consumer-summary.js';

const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:23,kickoffAt:null,providerData:{}};
const winner:GameProfile={gameId:game.id,season:2026,team:'GB',opponent:'NYJ',pointsFor:23,pointsAgainst:20,totalYards:199,opponentYards:350,penalties:13,penaltyYards:133,turnoverMargin:-1,nonOffensiveTouchdowns:1};
const loser:GameProfile={...winner,team:'NYJ',opponent:'GB',pointsFor:20,pointsAgainst:23,totalYards:350,opponentYards:199,penalties:4,penaltyYards:30,turnoverMargin:1};
function audit(wins=1,n=20){
 const reference:GameProfileReference={schemaVersion:1,version:'test',startSeason:2025,endSeason:2025,sourceUrls:[],sourceChecksums:{},notes:[],rows:Array.from({length:n},(_,i)=>({...winner,gameId:`2025_${i}_GB_NYJ`,season:2025,pointsFor:i<wins?23:10}))};
 return buildGameAudit({game,profiles:[winner,loser],reference,referenceChecksum:'a'.repeat(64)});
}

describe('consumer game verdicts',()=>{
 it.each([[1,'highly_unusual'],[2,'unusual'],[3,'no_flag']] as const)('uses the existing thresholds with %i wins', (wins,level)=>{
  const result=getGameVerdict(audit(wins));expect(result.level).toBe(level);
  if(level!=='no_flag')expect(result.comparison).toMatchObject({wins,matchingGames:20,winRate:wins/20});
 });
 it('states real outlier evidence without treating a tiny sample as proof',async()=>{
  const reference=JSON.parse(await readFile('analytics/models/game-profiles.json','utf8')) as GameProfileReference;
  const {profiles}=JSON.parse(await readFile('analytics/models/game-profile-validation.json','utf8')) as {profiles:GameProfile[]};
  const gb=profiles.find(p=>p.team==='GB')!;
  const result=getGameVerdict(buildGameAudit({game:{...game,awayScore:gb.pointsFor,homeScore:gb.pointsAgainst},profiles,reference,referenceChecksum:'a'.repeat(64)}));
  expect(result.label).toBe('Highly unusual win');expect(result.comparison).toMatchObject({wins:6,matchingGames:414});
  expect(result.summary).toContain('Green Bay Packers won');expect(result.reasons.join(' ')).toContain('133 yards');
  expect(result.evidenceNote).toContain('not the odds');
 });
 it('keeps a tiny winless historical group limited and does not show a win rate',()=>{
  const result=getGameVerdict(audit(0,14));expect(result.level).toBe('limited');expect(result.comparison?.winRate).toBeNull();expect(result.summary).toContain('14 matching games');
 });
 it('separates a key-play flag from result rarity',()=>{
  const a=audit(3);a.reviewCandidates=[{id:'p',playId:'1',quarter:4,clock:'00:30',description:'Penalty',team:'GB',reasons:['Late penalty'],priority:'medium',observedWpSwing:.1,existingEventId:null}];
  expect(getGameVerdict(a)).toMatchObject({level:'key_plays',reviewCount:1});
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
  expect(getGameVerdict(null)).toMatchObject({level:'limited',shortLabel:'Verdict pending'});
  expect(getGameVerdict(null,false)).toMatchObject({level:'awaiting'});
 });
 it('does not label a tie as an ordinary win',()=>{
  const a=audit();a.flags=[];a.profiles.forEach(p=>{p.pointsFor=20;p.pointsAgainst=20;});
  expect(getGameVerdict(a)).toMatchObject({level:'limited'});expect(getGameVerdict(a).summary).toContain('tie');
 });
 it('recognizes canonical and legacy Rams abbreviations',()=>{expect(teamName('LA')).toBe('Los Angeles Rams');expect(teamName('LAR')).toBe(teamName('LA'));});
});
