import { beforeAll,describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Game,GameProfile,SourceSnapshot } from '../packages/core/src/contracts.js';
import { buildMarketAudit,loadSpreadReference,type LoadedSpreadReference } from '../packages/core/src/spread.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { getGameVerdict } from '../packages/core/src/consumer-summary.js';
const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:10,kickoffAt:null,providerData:{result:10,spread_line:3}};
const source:SourceSnapshot={id:'schedule-fixture',provider:'nflverse-schedules',url:'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',checksum:'a'.repeat(64),path:'/synthetic',retrievedAt:'2026-09-21T00:00:00Z',license:'CC-BY-4.0'};
let fixed:LoadedSpreadReference;
beforeAll(async()=>{fixed=await loadSpreadReference();});
function reference(count=500,tail=25):LoadedSpreadReference{return {checksum:'b'.repeat(64),reference:{...fixed.reference,startSeason:2025,endSeason:2025,rows:Array.from({length:count},(_,i)=>[`2025_${i}_GB_NYJ`,2025,0,i<tail?40:0,0])}};}
function target(line:unknown,home=20,away=10):Game{return {...game,homeScore:home,awayScore:away,providerData:{result:home-away,spread_line:line}};}
function ratedAudit(line=3,tail=25){
 const g=target(line,40,0);
 const profiles:GameProfile[]=[g.homeTeam,g.awayTeam].map(team=>({gameId:g.id,season:g.season,team,opponent:team===g.homeTeam?g.awayTeam:g.homeTeam,pointsFor:team===g.homeTeam?40:0,pointsAgainst:team===g.homeTeam?0:40,totalYards:300,opponentYards:300,penalties:3,penaltyYards:20,turnoverMargin:0,nonOffensiveTouchdowns:0}));
 const audit=buildGameAudit({game:g,profiles,referenceChecksum:'c'.repeat(64),reference:{schemaVersion:1,version:'synthetic',startSeason:2025,endSeason:2025,sourceUrls:[],sourceChecksums:{},notes:[],rows:profiles.map(row=>({...row,gameId:'2025_01_GB_NYJ',season:2025}))}});
 audit.market=buildMarketAudit(g,source,reference(500,tail));return audit;
}
describe('recorded spread and empirical market surprise',()=>{
 it.each([
  [3,20,10,'NYJ','home_covered','NYJ',7,true,false],
  [3,10,20,'NYJ','away_covered','GB',13,false,true],
  [-3,20,10,'GB','home_covered','NYJ',13,false,true],
  [-3,10,20,'GB','away_covered','GB',7,true,false],
  [3,20,17,'NYJ','push',null,0,null,false],
  [-3,17,20,'GB','push',null,0,null,false],
  [0,20,17,null,'home_covered','NYJ',3,null,null],
  [0,17,17,null,'push',null,0,null,null],
 ] as const)('uses the home-margin sign convention for line %s and score %s–%s',(line,home,away,favoredTeam,atsResult,atsWinner,absoluteError,favoriteCovered,underdogWon)=>{
  const result=buildMarketAudit(target(line,home,away),source,fixed);
  expect(result).toMatchObject({status:'available',expectedHomeMargin:line,actualHomeMargin:home-away,homeMarginError:home-away-line,favoredTeam,atsResult,atsWinner,absoluteError,favoriteCovered,underdogWon,pickem:line===0});
 });
 it.each([null,undefined,'', '  ',true,'NA',NaN,Infinity])('does not turn missing/invalid %s into pick’em',(line)=>{
  expect(buildMarketAudit(target(line),source,fixed)).toMatchObject({status:'unavailable',reasonCode:'spread_line_missing',expectedHomeMargin:null,ratingFloor:null,pickem:null});
 });
 it('rejects unsupported line precision, nonfinal scores and missing provenance',()=>{
  expect(buildMarketAudit(target(3.14),source,fixed).reasonCode).toBe('spread_line_invalid');
  expect(buildMarketAudit({...target(3),homeScore:null},source,fixed).reasonCode).toBe('final_score_unavailable');
  expect(buildMarketAudit(target(3),null,fixed).reasonCode).toBe('schedule_provenance_unavailable');
 });
 it('counts one inclusive tail observation per strictly prior-season game',()=>{
  const ref=reference(500,25);ref.reference.rows.push(['2026_01_KC_LA',2026,0,50,0],['2027_01_KC_LA',2027,0,50,0]);
  const market=buildMarketAudit(target(0,40,0),source,ref);
  expect(market.reference).toMatchObject({games:500,atLeastAsSurprising:25,tailRate:.05,percentile:95,startSeason:2025,endSeason:2025});
  expect(market).toMatchObject({ratingFloor:3,surprise:'very_unusual'});
 });
 it('requires 500 prior games while retaining line and ATS context',()=>{
  expect(buildMarketAudit(target(0,40,0),source,reference(499))).toMatchObject({status:'available',absoluteError:40,reasonCode:'spread_reference_insufficient',ratingFloor:null,surprise:'unavailable',reference:{tailRate:null}});
 });
 it('keeps a small ordinary upset contextual and calibrates the fixed 10%/5% boundaries',()=>{
  expect(buildMarketAudit(target(3,10,13),source,reference(500,200))).toMatchObject({underdogWon:true,ratingFloor:1,surprise:'ordinary'});
  expect(buildMarketAudit(target(0,40,0),source,reference(500,50))).toMatchObject({ratingFloor:2,surprise:'unusual'});
  expect(buildMarketAudit(target(0,40,0),source,reference(500,51))).toMatchObject({ratingFloor:1,surprise:'ordinary'});
 });
 it('derives a complete reproducible 1999–2025 reference with a known real line',async()=>{
  expect(fixed.reference.rows).toHaveLength(7276);
  expect(fixed.reference.rows.find(row=>row[0]==='2023_01_DET_KC')).toEqual(['2023_01_DET_KC',2023,4,20,21]);
  expect(fixed.checksum).toBe(createHash('sha256').update(await readFile('analytics/models/spread-reference.json')).digest('hex'));
  expect(buildMarketAudit({...game,season:1999},source,fixed).reference.games).toBe(0);
 });
 it('uses max(existing rating, market floor), with market alone capped at Hmm and required data still required',()=>{
  expect(getGameVerdict(ratedAudit(3,25))).toMatchObject({rating:3,level:'hmm'});
  expect(getGameVerdict(ratedAudit(3,50))).toMatchObject({rating:2,level:'debatable'});
  const marketOnly=ratedAudit(3,0);expect(getGameVerdict(marketOnly).rating).toBe(3);
  marketOnly.profiles[0].penaltyYards=null;expect(getGameVerdict(marketOnly).level).toBe('limited');
 });
 it.each(['count','rate','score','future','checksum','floor'] as const)('does not raise the rating for inconsistent market %s evidence',(field)=>{
  const audit=ratedAudit();const m=audit.market!;
  if(field==='count')m.reference.atLeastAsSurprising=600;
  if(field==='rate')m.reference.tailRate=.001;
  if(field==='score')m.actualHomeMargin=0;
  if(field==='future')m.reference.endSeason=2026;
  if(field==='checksum')m.reference.checksum=null;
  if(field==='floor')m.ratingFloor=2;
  expect(getGameVerdict(audit).rating).toBe(1);
 });
});
