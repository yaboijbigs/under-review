import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { projectRoot } from './config.js';
import { analysisSchema,type AnalysisResult,type Game } from './contracts.js';
import type { ProviderRow } from './normalize.js';
import { estimateOvertimeTimeline,OVERTIME_MODEL_VERSION,validOvertimeReference,type OvertimeReference } from './overtime.js';

export const OVERTIME_MODEL_ID='overtime-empirical';
const probability=z.number().finite().min(0).max(1);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const phase=z.enum(['opening_possession_legacy','opening_possession_both','reply_to_field_goal','reply_to_touchdown','sudden_death','try','terminal','unknown']);
const season=z.number().int().min(2017).max(2025);
const referenceSchema=z.object({
 schemaVersion:z.literal(1),modelVersion:z.literal(OVERTIME_MODEL_VERSION),startSeason:season,endSeason:season,
 parameters:z.record(z.string(),z.number().finite()),
 sources:z.array(z.object({season,url:z.string().url(),checksum:hash,license:z.literal('CC-BY-4.0'),rows:z.number().int().nonnegative(),overtimeGames:z.number().int().nonnegative()}).passthrough()).min(1),
 rows:z.array(z.object({gameId:z.string().regex(/^20\d{2}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/),season,playId:z.string().min(1),phase,
  clock:z.number().finite().positive().max(600),down:z.number().int().min(1).max(4),distance:z.number().finite().min(1).max(99),
  yardline:z.number().finite().positive().lt(100),scoreDifference:z.number().int(),ownTimeouts:z.number().int().min(0).max(2),opponentTimeouts:z.number().int().min(0).max(2),outcome:z.enum(['win','loss','tie'])}).passthrough()).min(1),
 notes:z.array(z.string()),checksum:hash,
}).passthrough();
const pointSchema=z.object({playId:z.string().min(1),homeWp:probability.nullable(),awayWp:probability.nullable(),tieProbability:probability.nullable(),
 status:z.enum(['experimental','unavailable','observed']),reasonCode:z.string().nullable(),modelVersion:z.literal(OVERTIME_MODEL_VERSION),supportGames:z.number().int().nonnegative(),phase});

export interface LoadedOvertimeReference {reference:OvertimeReference;checksum:string}
export class OvertimeIntegrationError extends Error {
 constructor(public readonly code:string,message:string){super(message);this.name='OvertimeIntegrationError';}
}
function fail(code:string,message:string):never{throw new OvertimeIntegrationError(code,message);}

/** Validate the frozen source manifest and payload checksum, retaining original key order. */
export async function loadOvertimeReference(file=path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'overtime-reference.json')):Promise<LoadedOvertimeReference>{
 let bytes:Buffer,raw:unknown;
 try{bytes=await readFile(file);raw=JSON.parse(bytes.toString('utf8'));}
 catch{fail('overtime_reference_unavailable','The fixed overtime reference is unavailable or unreadable.');}
 if(bytes.length>32*1024*1024||!referenceSchema.safeParse(raw).success)fail('overtime_reference_invalid','The fixed overtime reference has invalid structured data.');
 const reference=raw as OvertimeReference;
 if(reference.startSeason>reference.endSeason||!validOvertimeReference(reference))fail('overtime_reference_invalid','The overtime model version, parameters or payload checksum does not match the frozen reference.');
 const sources=new Map(reference.sources.map(source=>[source.season,source]));
 if(sources.size!==reference.sources.length||reference.sources.some(source=>source.season<reference.startSeason||source.season>reference.endSeason
  ||source.url!==`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${source.season}.csv`))fail('overtime_reference_invalid','The overtime reference has ambiguous or unexpected source provenance.');
 const rows=new Set<string>();
 for(const row of reference.rows){
  const key=`${row.gameId}:${row.playId}`;
  if(rows.has(key)||Number(row.gameId.slice(0,4))!==row.season||row.season<reference.startSeason||row.season>reference.endSeason||!sources.has(row.season))fail('overtime_reference_invalid','The overtime reference has duplicate or unmatched historical play identities.');
  rows.add(key);
 }
 return {reference,checksum:createHash('sha256').update(bytes).digest('hex')};
}

export function overtimeModel(loaded:LoadedOvertimeReference):AnalysisResult['models'][number]{
 return {id:OVERTIME_MODEL_ID,version:OVERTIME_MODEL_VERSION,checksum:loaded.checksum,
  trainingWindow:`${loaded.reference.startSeason}–${loaded.reference.endSeason}; comparisons use strictly prior seasons`,
  notes:'Experimental empirical overtime estimates for supported possession phases; not calibrated coaching or officiating costs. Points describe pre-play win/loss/tie probabilities, except END GAME is an observed outcome. Sparse, unsupported and ambiguous states remain unavailable.'};
}

/** Replace only OT timeline rows and its model metadata; all R results remain intact. */
export function applyOvertimeTimeline(game:Game,plays:ProviderRow[],analysis:AnalysisResult,loaded:LoadedOvertimeReference):AnalysisResult{
 const overtime=plays.filter(play=>Number(play.qtr)>4);
 const points=estimateOvertimeTimeline(game,plays,loaded.reference);
 if(points.length!==overtime.length)fail('overtime_timeline_invalid','The overtime estimator did not return every provider row.');
 const ids=new Set<string>();
 const timeline=points.map((raw,index)=>{
  const point=pointSchema.parse(raw),play=overtime[index];
  if(point.playId!==String(play.play_id)||ids.has(point.playId))fail('overtime_timeline_invalid','Overtime points do not match unique provider order.');
  ids.add(point.playId);
  const values=[point.homeWp,point.awayWp,point.tieProbability];
  if(point.status==='unavailable'){
   if(values.some(value=>value!==null)||!point.reasonCode)fail('overtime_timeline_invalid','Unavailable overtime states must withhold all probabilities and give a reason.');
  }else if(values.some(value=>value===null)||Math.abs(values.reduce<number>((sum,value)=>sum+(value??0),0)-1)>1e-9){
   fail('overtime_timeline_invalid','Overtime probabilities do not form a complete win/loss/tie distribution.');
  }
  if(point.status==='observed'){
   const home=play.total_home_score,away=play.total_away_score;
   if(String(play.desc).trim()!=='END GAME'||typeof home!=='number'||typeof away!=='number'||home!==game.homeScore||away!==game.awayScore
    ||point.homeWp!==(home>away?1:0)||point.awayWp!==(away>home?1:0)||point.tieProbability!==(home===away?1:0))fail('overtime_timeline_invalid','Observed overtime outcomes must match the validated terminal score.');
  }
  return analysisSchema.shape.timeline.element.parse({...point,quarter:Number(play.qtr),clock:play.time===null||play.time===undefined?null:String(play.time),description:String(play.desc??'')});
 });
 const warning='overtime_model_experimental: Overtime estimates are partial, empirical and uncalibrated; unavailable states remain gaps. Terminal values are observed results, not predictions.';
 let warningAdded=false,modelAdded=false;
 const warnings=analysis.warnings.flatMap(existing=>{
  if(!existing.startsWith('overtime_model_experimental:'))return [existing];
  if(!overtime.length||warningAdded)return [];
  warningAdded=true;return [warning];
 });
 if(overtime.length&&!warningAdded)warnings.push(warning);
 const metadata=overtimeModel(loaded);
 const models=analysis.models.flatMap(model=>{
  if(model.id!==OVERTIME_MODEL_ID)return [model];
  if(modelAdded)return [];
  modelAdded=true;return [metadata];
 });
 if(!modelAdded)models.push(metadata);
 return {...analysis,timeline:[...analysis.timeline.filter(point=>!ids.has(point.playId)&&(point.quarter===null||point.quarter<=4)),...timeline],
  models,warnings};
}
