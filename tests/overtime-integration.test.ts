import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe,expect,it } from 'vitest';
import type { AnalysisResult,Game } from '../packages/core/src/contracts.js';
import type { ProviderRow } from '../packages/core/src/normalize.js';
import { applyOvertimeTimeline,loadOvertimeReference,OVERTIME_MODEL_ID,type LoadedOvertimeReference } from '../packages/core/src/overtime-integration.js';
import { OVERTIME_MODEL_VERSION,OVERTIME_PARAMETERS,overtimeReferenceChecksum,type OvertimeReference } from '../packages/core/src/overtime.js';

const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:0,awayScore:3,kickoffAt:'2026-09-20T17:00:00Z',providerData:{synthetic:true}};
const baseline:AnalysisResult={schemaVersion:1,metrics:[],events:[],coverage:[],warnings:['R warning'],models:[{id:'R-kernel',version:'frozen'}],timeline:[{playId:'1',quarter:4,clock:'00:10',homeWp:0.42,description:'Regulation point'}, {playId:'11',quarter:5,clock:'09:50',homeWp:null,description:'Old R unavailable point'}]};
function fixture(){
 const common={qtr:5,score_differential:0,posteam_timeouts_remaining:2,defteam_timeouts_remaining:2,down:1,ydstogo:10,yardline_100:50,total_home_score:0,total_away_score:0};
 const plays:ProviderRow[]=[{play_id:1,qtr:4},
  {...common,play_id:10,quarter_seconds_remaining:600,time:'10:00',posteam:'NYJ',defteam:'GB',down:null,kickoff_attempt:1,desc:'Synthetic opening kickoff'},
  {...common,play_id:11,quarter_seconds_remaining:590,time:'09:50',posteam:'NYJ',defteam:'GB',play_type:'run',desc:'Synthetic opening play'},
  {...common,play_id:12,quarter_seconds_remaining:570,time:'09:30',posteam:'NYJ',defteam:'GB',down:4,punt_attempt:1,desc:'Synthetic punt'},
  {...common,play_id:13,quarter_seconds_remaining:540,time:'09:00',posteam:'GB',defteam:'NYJ',play_type:'run',desc:'Synthetic sudden-death play'},
  {...common,play_id:14,quarter_seconds_remaining:500,time:'08:20',posteam:'GB',defteam:'NYJ',field_goal_attempt:1,field_goal_result:'made',total_away_score:3,desc:'Synthetic field goal'},
  {...common,play_id:15,quarter_seconds_remaining:495,time:'08:15',posteam:'GB',defteam:'NYJ',total_away_score:3,down:null,desc:'END GAME'}];
 const reference:OvertimeReference={schemaVersion:1,modelVersion:OVERTIME_MODEL_VERSION,startSeason:2020,endSeason:2020,parameters:{...OVERTIME_PARAMETERS},
  sources:[{season:2020,url:'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2020.csv',checksum:'a'.repeat(64),license:'CC-BY-4.0',rows:20,overtimeGames:20}],
  rows:Array.from({length:20},(_,index)=>({gameId:`2020_${String(index+1).padStart(2,'0')}_TST_DMO`,season:2020,playId:'13',phase:'sudden_death',clock:540,down:1,distance:10,yardline:50,scoreDifference:0,ownTimeouts:2,opponentTimeouts:2,outcome:index===0?'tie':index<11?'win':'loss'})),notes:['Explicitly synthetic integration fixture.'],checksum:''};
 reference.checksum=overtimeReferenceChecksum(reference);
 return {plays,loaded:{reference,checksum:'b'.repeat(64)} satisfies LoadedOvertimeReference};
}

describe('overtime integration preserves the regulation analysis',()=>{
 it('keeps R results and regulation rows, records gaps and separates observed final outcomes',()=>{
  const {plays,loaded}=fixture();const original=structuredClone(baseline);
  const output=applyOvertimeTimeline(game,plays,baseline,loaded);
  for(const key of ['metrics','events','coverage'] as const)expect(output[key]).toEqual(baseline[key]);
  expect(output.timeline[0]).toEqual(baseline.timeline[0]);
  expect(output.timeline.filter(point=>point.quarter===5).map(point=>point.playId)).toEqual(['10','11','12','13','14','15']);
  expect(output.timeline.find(point=>point.playId==='11')).toMatchObject({status:'unavailable',homeWp:null,awayWp:null,tieProbability:null,reasonCode:'insufficient_current_rule_opening_games'});
  const modeled=output.timeline.find(point=>point.playId==='13')!;
  expect(modeled).toMatchObject({status:'experimental',supportGames:20,phase:'sudden_death',modelVersion:OVERTIME_MODEL_VERSION});
  expect(modeled.homeWp!+modeled.awayWp!+modeled.tieProbability!).toBeCloseTo(1,12);expect(modeled.tieProbability).toBeGreaterThan(0);
  expect(output.timeline.at(-1)).toMatchObject({status:'observed',homeWp:0,awayWp:1,tieProbability:0,reasonCode:'observed_terminal_result'});
  expect(output.models.find(model=>model.id===OVERTIME_MODEL_ID)?.checksum).toBe(loaded.checksum);
  expect(baseline).toEqual(original);
 });
 it('is exactly idempotent even when later audit metadata and warnings follow the OT entries',()=>{
  const {plays,loaded}=fixture();const output=applyOvertimeTimeline(game,plays,baseline,loaded);
  output.models.push({id:'game-profile-audit',version:'v3'});output.warnings.push('Optional aggregate source warning');
  expect(applyOvertimeTimeline(game,plays,output,loaded)).toEqual(output);
 });
 it('attaches reproducible metadata without changing a regulation-only timeline',()=>{
  const {loaded}=fixture();const analysis={...baseline,timeline:baseline.timeline.slice(0,1)};
  const output=applyOvertimeTimeline(game,[{play_id:1,qtr:4}],analysis,loaded);
  expect(output.timeline).toEqual(analysis.timeline);expect(output.warnings).toEqual(analysis.warnings);
  expect(output.models.map(model=>model.id)).toEqual(['R-kernel',OVERTIME_MODEL_ID]);
 });
 it('records an observed tie as 0/0/1 and refuses a terminal score conflicting with the validated game',()=>{
  const {plays,loaded}=fixture();const terminal={...plays.at(-1),total_away_score:0};
  const tied=applyOvertimeTimeline({...game,awayScore:0},[terminal],baseline,loaded);
  expect(tied.timeline.at(-1)).toMatchObject({status:'observed',homeWp:0,awayWp:0,tieProbability:1});
  expect(()=>applyOvertimeTimeline(game,[terminal],baseline,loaded)).toThrow('validated terminal score');
 });
 it('validates artifact structure, internal checksum, historical identities and source attribution',async()=>{
  const {loaded}=fixture();const directory=await mkdtemp(path.join(os.tmpdir(),'under-review-ot-reference-'));
  const file=path.join(directory,'reference.json');
  try{
   await writeFile(file,JSON.stringify(loaded.reference));const accepted=await loadOvertimeReference(file);
   expect(accepted.reference).toEqual(loaded.reference);expect(accepted.checksum).toMatch(/^[a-f0-9]{64}$/);
   const modified=structuredClone(loaded.reference);modified.rows[0].clock=NaN;
   await writeFile(file,JSON.stringify(modified));await expect(loadOvertimeReference(file)).rejects.toMatchObject({code:'overtime_reference_invalid'});
   modified.rows[0].clock=530;await writeFile(file,JSON.stringify(modified));await expect(loadOvertimeReference(file)).rejects.toMatchObject({code:'overtime_reference_invalid'});
   const duplicate=structuredClone(loaded.reference);duplicate.rows.push(duplicate.rows[0]);duplicate.checksum=overtimeReferenceChecksum(duplicate);
   await writeFile(file,JSON.stringify(duplicate));await expect(loadOvertimeReference(file)).rejects.toMatchObject({code:'overtime_reference_invalid'});
   const untrusted=structuredClone(loaded.reference);untrusted.sources[0].url='https://example.invalid/reference';untrusted.checksum=overtimeReferenceChecksum(untrusted);
   await writeFile(file,JSON.stringify(untrusted));await expect(loadOvertimeReference(file)).rejects.toMatchObject({code:'overtime_reference_invalid'});
  }finally{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('under-review-ot-reference-'))throw new Error('Unsafe fixture cleanup path');await rm(directory,{recursive:true});}
 });
});
