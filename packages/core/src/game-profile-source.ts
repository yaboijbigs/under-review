import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gameProfileSchema, type Game, type GameProfile, type GameProfileReference, type SourceSnapshot } from './contracts.js';
import { numberOrNull, parseCsv, type ProviderRow } from './normalize.js';
import { SOURCE_LICENSES, SourceError, type SnapshotStore } from './sources.js';

const aliases:Record<string,string>={OAK:'LV',SD:'LAC',STL:'LA',LAR:'LA',JAC:'JAX',WSH:'WAS'};
const team=(value:unknown)=>aliases[String(value)]??String(value??'');
const sum=(...values:(number|null)[])=>values.some(v=>v===null)?null:values.reduce<number>((a,b)=>a+b!,0);
const stat=(row:ProviderRow,key:string)=>numberOrNull(row[key]);
const yards=(row:ProviderRow)=>sum(stat(row,'rushing_yards'),stat(row,'passing_yards'),stat(row,'sack_yards_lost'));
const turnovers=(row:ProviderRow)=>sum(stat(row,'passing_interceptions'),stat(row,'fumbles_lost_total'));
const nonOffensiveTouchdowns=(row:ProviderRow)=>{
 const recoveries=stat(row,'fumble_recovery_tds');
 // Provider fumble recovery TDs can be offensive, defensive, or overlap other TD fields.
 return recoveries===null||recoveries>0?null:sum(stat(row,'def_tds'),stat(row,'special_teams_tds'));
};
const referenceSchema=z.object({schemaVersion:z.literal(1),version:z.string(),startSeason:z.number().int(),endSeason:z.number().int(),sourceUrls:z.array(z.string()),sourceChecksums:z.record(z.string(),z.string()),rows:z.array(gameProfileSchema),notes:z.array(z.string())});

export async function loadGameProfileReference(file:string):Promise<{reference:GameProfileReference;checksum:string}>{
 const bytes=await readFile(file);
 const reference=referenceSchema.parse(JSON.parse(bytes.toString()));
 const ids=new Set<string>();
 for(const row of reference.rows){
  const key=`${row.gameId}:${row.team}`;
  if(ids.has(key)||row.season<reference.startSeason||row.season>reference.endSeason)throw new Error('Invalid historical team-game reference identity.');
  ids.add(key);
 }
 return {reference,checksum:createHash('sha256').update(bytes).digest('hex')};
}

/** Use the paired accepted-penalty stat aggregates, never the first flag in a PBP row. */
export function normalizeGameProfiles(game:Game,rows:ProviderRow[]):GameProfile[]{
 const pair=rows.filter(r=>r.game_id===game.id);
 if(pair.length!==2||pair.some(r=>!r.team||!r.opponent_team||stat(r,'season')!==game.season||stat(r,'week')!==game.week))throw new SourceError('team_stats_incomplete','Final paired team statistics are not available for this game.',true);
 const home=pair.find(r=>team(r.team)===team(game.homeTeam));
 const away=pair.find(r=>team(r.team)===team(game.awayTeam));
 if(!home||!away||home===away||team(home.opponent_team)!==team(away.team)||team(away.opponent_team)!==team(home.team))throw new SourceError('team_stats_identity','Team statistics do not match the scheduled opponents.');
 return [false,true].map(isHome=>{
  const own=isHome?home:away,other=isHome?away:home;
  const lost=turnovers(own),taken=turnovers(other);
  return gameProfileSchema.parse({gameId:game.id,season:game.season,team:isHome?game.homeTeam:game.awayTeam,opponent:isHome?game.awayTeam:game.homeTeam,
   pointsFor:isHome?game.homeScore:game.awayScore,pointsAgainst:isHome?game.awayScore:game.homeScore,
   totalYards:yards(own),opponentYards:yards(other),penalties:stat(own,'penalties'),penaltyYards:stat(own,'penalty_yards'),
   turnoverMargin:lost===null||taken===null?null:taken-lost,nonOffensiveTouchdowns:nonOffensiveTouchdowns(own)});
 });
}

/** PBP is a consistency gate only; the compared values always remain aggregate statistics. */
export function validateGameProfileFinality(game:Game,rows:ProviderRow[],profiles:GameProfile[],finalPbp?:ProviderRow[]):void{
 const weightedScoring:Record<string,number>={passing_tds:6,rushing_tds:6,def_tds:6,special_teams_tds:6,
  fg_made:3,pat_made:1,passing_2pt_conversions:2,rushing_2pt_conversions:2,def_2pt_made:2,def_safeties:2};
 for(const profile of profiles){
  const row=rows.find(r=>r.game_id===game.id&&team(r.team)===team(profile.team));
  let points=0;
  for(const [field,weight] of Object.entries(weightedScoring)){
   const value=row?stat(row,field):null;
   if(value===null||!Number.isInteger(value)||value<0)throw new SourceError('team_stats_scoring_incomplete','Aggregate scoring components are missing or invalid.',true);
   points+=weight*value;
  }
  // Offensive fumble recoveries and other unusual scoring may be unrepresentable by this
  // conservative decomposition. A mismatch withholds comparison instead of guessing.
  if(profile.pointsFor===null||points!==profile.pointsFor)throw new SourceError('team_stats_score_mismatch','Aggregate scoring does not reconcile with the final schedule score.',true);
 }
 if(!finalPbp?.length||finalPbp.at(-1)?.desc!=='END GAME')throw new SourceError('team_stats_final_pbp_unavailable','Validated final play-by-play is required to check aggregate completeness.',true);
 const totals=new Map(profiles.map(p=>[team(p.team),{yards:0,plays:0}]));
 const yes=(value:unknown)=>value===true||value===1||value==='1';
 for(const play of finalPbp){
  if(play.game_id!==game.id)throw new SourceError('team_stats_pbp_identity','Consistency-check play-by-play contains a different or unidentified game.');
  if(play.play_type==='no_play'||yes(play.no_play)||yes(play.two_point_attempt)||yes(play.extra_point_attempt))continue;
  if(!['run','pass','qb_kneel','qb_spike'].includes(String(play.play_type))&&!yes(play.sack))continue;
  const total=totals.get(team(play.posteam));const gain=stat(play,'yards_gained');
  if(!total||gain===null||!Number.isInteger(gain))throw new SourceError('team_stats_pbp_yards_incomplete','Final play-by-play has unattributed or missing scrimmage yardage.',true);
  total.yards+=gain;total.plays++;
 }
 for(const profile of profiles){
  const total=totals.get(team(profile.team));
  if(!total?.plays||profile.totalYards===null)throw new SourceError('team_stats_pbp_yards_incomplete','Net offensive yardage cannot be checked for both teams.',true);
  if(total.yards!==profile.totalYards)throw new SourceError('team_stats_yards_mismatch','Aggregate net offensive yards disagree with validated final play-by-play.',true);
 }
}

export async function ingestGameProfiles(game:Game,store:SnapshotStore,finalPbp?:ProviderRow[]):Promise<{profiles:GameProfile[];snapshots:SourceSnapshot[];warnings:string[]}>{
 const snapshots:SourceSnapshot[]=[];
 try{
  const snapshot=await store.fetch({provider:'nflverse-team-stats',url:`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`,license:SOURCE_LICENSES.nflverse,extension:'csv',metadata:{season:game.season,attribution:'nflverse / nflfastR',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'}});
  snapshots.push(snapshot);
  const rows=parseCsv(await store.read(snapshot));
  const profiles=normalizeGameProfiles(game,rows);
  validateGameProfileFinality(game,rows,profiles,finalPbp);
  const incomplete=profiles.some(p=>[p.totalYards,p.opponentYards,p.penalties,p.penaltyYards,p.turnoverMargin].some(v=>v===null));
  return {profiles,snapshots,warnings:incomplete?['team_profile_fields_missing: Historical comparisons use only available aggregate fields.']:[]};
 }catch(error){
  return {profiles:[],snapshots,warnings:[`${error instanceof SourceError?error.code:'team_stats_unavailable'}: Game-profile comparison awaits paired team statistics; play review remains available.`]};
 }
}
