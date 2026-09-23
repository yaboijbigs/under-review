import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { projectRoot } from './config.js';
import type { AnalysisResult,Game,MarketAudit,SourceSnapshot } from './contracts.js';
import { sourceUrls } from './sources.js';

export const SPREAD_VERSION='under-review-spread-v1';
export const SPREAD_MODEL_ID='spread-reference';
export const SPREAD_MIN_GAMES=500;
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema=z.object({schemaVersion:z.literal(1),version:z.literal('nflverse-spread-reference-v1'),startSeason:z.number().int().min(1999),endSeason:z.number().int().max(2025),
 source:z.object({url:z.literal(sourceUrls.schedules),checksum:sha,retrievedAt:z.string(),license:z.literal('CC-BY-4.0'),archive:z.string()}),
 columns:z.tuple([z.literal('gameId'),z.literal('season'),z.literal('expectedHomeMargin'),z.literal('homeScore'),z.literal('awayScore')]),
 rows:z.array(z.tuple([z.string(),z.number().int(),z.number().finite().min(-100).max(100),z.number().int().nonnegative(),z.number().int().nonnegative()])),notes:z.array(z.string()),rowsChecksum:sha});
export type SpreadReference=z.infer<typeof referenceSchema>;
export interface LoadedSpreadReference {reference:SpreadReference;checksum:string}
export async function loadSpreadReference(file=path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'spread-reference.json')):Promise<LoadedSpreadReference>{
 const bytes=await readFile(file),reference=referenceSchema.parse(JSON.parse(bytes.toString()));
 if(hash(JSON.stringify(reference.rows))!==reference.rowsChecksum||reference.endSeason<reference.startSeason)throw new Error('Invalid spread reference checksum or season range.');
 const seen=new Set<string>();
 for(const [id,season,line] of reference.rows){
  if(!id.startsWith(`${season}_`)||season<reference.startSeason||season>reference.endSeason||seen.has(id)||!Number.isInteger(line*2))throw new Error('Invalid spread reference game identity.');seen.add(id);
 }
 return {reference,checksum:hash(bytes)};
}
const numeric=(value:unknown):number|null=>typeof value==='boolean'||value===null||value===undefined||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null;
const notes=[
 'Recorded nflverse closing spread: positive is expected home winning margin; bookmaker and quote timestamp are not supplied. This is not a live betting quote.',
 'Absolute error = |home final score − away final score − recorded spread|; final scores include overtime. A cover, push or upset alone is not an unusual-market flag.',
 'Inclusive tail frequency counts prior-season games with equal or larger absolute errors. All regular-season and postseason games are pooled, across eras; this is descriptive, not a calibrated prediction or p-value.',
 'At least 500 prior games are required. Tail frequency ≤10% supplies rating floor 2; ≤5% supplies floor 3. Product screening thresholds are exploratory, not evidence of misconduct.',
 'Market surprise alone cannot exceed Hmm (3/5); overlapping signals are not added together. It does not establish call correctness, manipulation or betting misconduct.'
];
/** Pure descriptive calculation from the exact saved schedule row, never an inferred missing line. */
export function buildMarketAudit(game:Game,snapshot:SourceSnapshot|null,loaded:LoadedSpreadReference):MarketAudit{
 const prior=loaded.reference.rows.filter(row=>row[1]<game.season&&row[0]!==game.id);
 const years=prior.map(row=>row[1]);
 const result:MarketAudit={version:SPREAD_VERSION,status:'unavailable',reasonCode:null,homeTeam:game.homeTeam,awayTeam:game.awayTeam,
  expectedHomeMargin:null,actualHomeMargin:null,homeMarginError:null,absoluteError:null,favoredTeam:null,pickem:null,atsWinner:null,atsResult:null,favoriteCovered:null,underdogWon:null,
  surprise:'unavailable',ratingFloor:null,source:null,reference:{version:loaded.reference.version,checksum:loaded.checksum,startSeason:years.length?Math.min(...years):null,endSeason:years.length?Math.max(...years):null,games:prior.length,atLeastAsSurprising:0,tailRate:null,percentile:null},notes:[...notes]};
 if(!snapshot||snapshot.provider!=='nflverse-schedules'||snapshot.url!==sourceUrls.schedules||!/^[a-f0-9]{64}$/.test(snapshot.checksum)){result.reasonCode='schedule_provenance_unavailable';return result;}
 result.source={snapshotId:snapshot.id,url:snapshot.url,checksum:snapshot.checksum,retrievedAt:snapshot.retrievedAt,field:'spread_line'};
 const line=numeric(game.providerData.spread_line),home=numeric(game.homeScore),away=numeric(game.awayScore);
 if(home===null||away===null||!Number.isInteger(home)||!Number.isInteger(away)||home<0||away<0||numeric(game.providerData.result)!==home-away){result.reasonCode='final_score_unavailable';return result;}
 result.actualHomeMargin=home-away;
 if(line===null){result.reasonCode='spread_line_missing';return result;}
 if(Math.abs(line)>100||!Number.isInteger(line*2)){result.reasonCode='spread_line_invalid';return result;}
 const residual=home-away-line,error=Math.abs(residual),favorite=line>0?game.homeTeam:line<0?game.awayTeam:null;
 Object.assign(result,{status:'available',expectedHomeMargin:line,homeMarginError:residual,absoluteError:error,favoredTeam:favorite,pickem:line===0,
  atsWinner:residual>0?game.homeTeam:residual<0?game.awayTeam:null,atsResult:residual>0?'home_covered':residual<0?'away_covered':'push',
  favoriteCovered:favorite===null||residual===0?null:(line>0?residual>0:residual<0),underdogWon:favorite===null?null:(line>0?away>home:home>away)});
 const tail=prior.filter(row=>Math.abs(row[3]-row[4]-row[2])>=error).length;
 result.reference.atLeastAsSurprising=tail;
 if(prior.length<SPREAD_MIN_GAMES){result.reasonCode='spread_reference_insufficient';return result;}
 const rate=tail/prior.length;
 result.reference.tailRate=rate;result.reference.percentile=100*(1-rate);
 result.surprise=rate<=.05?'very_unusual':rate<=.1?'unusual':'ordinary';result.ratingFloor=rate<=.05?3:rate<=.1?2:1;
 return result;
}
export function applySpreadAudit(game:Game,analysis:AnalysisResult,snapshots:SourceSnapshot[],loaded:LoadedSpreadReference):AnalysisResult{
 if(!analysis.gameAudit)throw new Error('A game audit is required before adding the market comparison.');
 const schedules=snapshots.filter(source=>source.provider==='nflverse-schedules');
 const next=structuredClone(analysis);next.gameAudit!.market=buildMarketAudit(game,schedules.length===1?schedules[0]:null,loaded);
 const metadata={id:SPREAD_MODEL_ID,version:SPREAD_VERSION,checksum:loaded.checksum,trainingWindow:`${loaded.reference.startSeason}–${loaded.reference.endSeason}; strictly prior target seasons`,notes:'Descriptive absolute margin error versus recorded closing spread; no misconduct probability; market-only rating capped at 3/5.'};
 const at=next.models.findIndex(model=>model.id===SPREAD_MODEL_ID);
 next.models=next.models.filter((model,index)=>model.id!==SPREAD_MODEL_ID||index===at);
 if(at>=0)next.models[at]=metadata;else next.models.push(metadata);
 return next;
}
