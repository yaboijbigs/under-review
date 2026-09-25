import path from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { parse } from 'csv-parse';
import { config,projectRoot } from './config.js';
import { query } from './db.js';
import type { AnalysisResult,Game,GameProfile,SourceSnapshot } from './contracts.js';
import { assertGameId,normalizeRow,normalizeSchedule,parseCsv,validateGameData,type ProviderRow } from './normalize.js';
import { LocalSnapshotStore,SourceError,sourceUrls } from './sources.js';
import { getReport,RevisionConflictError,saveAnalysis,stableJson } from './repository.js';
import { buildGameAudit,GAME_AUDIT_VERSION } from './game-audit.js';
import { ingestGameProfiles,loadGameProfileReference } from './game-profile-source.js';
import { applySpreadAudit,loadSpreadReference } from './spread.js';
import { loadExpectationsReference } from './expectations.js';
import { applyExpectationsAudit } from './expectations-integration.js';
import { getGameVerdict } from './consumer-summary.js';
import { maybeAutomaticDraft } from './publishing.js';

/** Invalid saved evidence requires normal analysis, not endless aggregate retries. */
export class DataCompletionError extends Error {
 constructor(public readonly code:string,message:string){super(message);this.name='DataCompletionError';}
}
export type DataCompletionResult = {
 gameId:string;
 status:'waiting'|'updated'|'already_complete'|'stale';
 revisionId?:string;
 revisionNumber?:number;
 reasonCode?:string;
 warnings:string[];
};
const aggregateWarning=(warning:string)=>/^(?:team_stats_|team_profile_)/.test(warning)
 ||/^source_[a-z0-9_]+: Game-profile comparison awaits paired team statistics; play review remains available\.$/.test(warning);
const requiredFields=['pointsFor','pointsAgainst','totalYards','opponentYards','penalties','penaltyYards','turnoverMargin'] as const;
const completeProfile=(profile:GameProfile)=>requiredFields.every(field=>typeof profile[field]==='number'&&Number.isFinite(profile[field]));
function completePair(profiles:GameProfile[]):boolean {
 if(profiles.length!==2||!profiles.every(completeProfile))return false;
 const [a,b]=profiles;
 return a.gameId===b.gameId&&a.season===b.season&&a.team!==b.team&&a.team===b.opponent&&b.team===a.opponent
  &&a.pointsFor===b.pointsAgainst&&b.pointsFor===a.pointsAgainst&&a.totalYards===b.opponentYards&&b.totalYards===a.opponentYards&&a.turnoverMargin===-b.turnoverMargin!;
}
/** Missing optional charting, referee attribution or historical models is not this retry path. */
export function isPendingGameData(analysis:AnalysisResult):boolean {
 return getGameVerdict(analysis.gameAudit).rating===null&&!completePair(analysis.gameAudit?.profiles??[])
  &&analysis.warnings.some(aggregateWarning);
}

function sourceIdentity(snapshot:SourceSnapshot,expectedUrl:string):void {
 if(snapshot.url!==expectedUrl||!/^[a-f0-9]{64}$/.test(snapshot.checksum))throw new DataCompletionError('completion_snapshot_identity','Saved source does not identify the expected immutable game data. Run normal analysis.');
}
async function readSaved(store:LocalSnapshotStore,snapshot:SourceSnapshot,extension:'csv'|'rds'):Promise<Buffer>{
 try{return await store.read({...snapshot,path:path.join(store.root,'snapshots',`${snapshot.checksum}.${extension}`)});}
 catch{throw new DataCompletionError('completion_snapshot_unreadable','Saved source bytes are missing or fail their checksum. Run normal analysis; the report was preserved.');}
}
async function savedInputs(game:Game,snapshots:SourceSnapshot[],store:LocalSnapshotStore):Promise<{plays:ProviderRow[];sourceKind:'raw'|'clean';pbp:SourceSnapshot}>{
 const schedules=snapshots.filter(source=>source.provider==='nflverse-schedules');
 const pbp=snapshots.filter(source=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider));
 if(schedules.length!==1||pbp.length!==1||snapshots.filter(source=>source.provider==='nflverse-team-stats').length>1)throw new DataCompletionError('completion_snapshot_ambiguous','The report must identify one schedule and one play-by-play source, and at most one aggregate source. Run normal analysis.');
 const sourceKind=pbp[0].provider==='nflverse-pbp'?'clean':'raw';
 sourceIdentity(schedules[0],sourceUrls.schedules);
 sourceIdentity(pbp[0],sourceKind==='clean'?sourceUrls.clean(game.season):sourceUrls.raw(game.id));
 const scheduleRows=parseCsv(await readSaved(store,schedules[0],'csv')).filter(row=>row.game_id===game.id);
 if(scheduleRows.length!==1||stableJson(normalizeSchedule(scheduleRows[0]))!==stableJson(game))throw new DataCompletionError('completion_schedule_mismatch','The saved game differs from its immutable schedule. Run normal analysis.');
 const rows=(await query('SELECT snapshot_id,play_id,provider_order,data FROM plays WHERE game_id=$1 AND snapshot_id=$2 ORDER BY provider_order',[game.id,pbp[0].id])).rows;
 if(!rows.length||rows.some((row,index)=>row.snapshot_id!==pbp[0].id||row.provider_order!==index||String(row.data?.play_id)!==row.play_id))throw new DataCompletionError('completion_pbp_snapshot_mismatch','Saved plays do not match the report source and original provider order. Run normal analysis.');
 const plays=rows.map(row=>row.data as ProviderRow);
 const validation=validateGameData(game,plays);
 if(!validation.valid)throw new DataCompletionError('completion_pbp_incomplete',`Saved play-by-play is not a complete final game: ${validation.issues.join(', ')}. Run normal analysis.`);
 return {plays,sourceKind,pbp:pbp[0]};
}

/** Consume the entire CSV for syntax integrity, retaining only this game's rows. */
async function verifySavedPbp(game:Game,saved:Awaited<ReturnType<typeof savedInputs>>,store:LocalSnapshotStore):Promise<void>{
 // Defer this potentially large read until aggregates are ready. Raw bytes are
 // checksum-verified without decoding R; the original database rows were validated above.
 const bytes=await readSaved(store,saved.pbp,saved.sourceKind==='clean'?'csv':'rds');
 if(saved.sourceKind==='raw')return;
 const targetRows:ProviderRow[]=[];
 // Small chunks preserve stream backpressure; one season-sized write would let
 // the CSV parser buffer every record before the consumer could discard it.
 const input=Readable.from((function*(){for(let start=0;start<bytes.length;start+=64*1024)yield bytes.subarray(start,start+64*1024);})());
 const parser=parse({columns:(headers:string[])=>{
  if(headers.some(header=>!header)||new Set(headers).size!==headers.length)throw new SourceError('source_csv_columns_invalid','CSV has empty or duplicate column names.');
  return headers;
 },bom:true,skip_empty_lines:true,max_record_size:1024*1024});
 input.pipe(parser);
 let records=0;
 try{
  for await(const row of parser){
   if(row.game_id===game.id)targetRows.push({...normalizeRow(row as ProviderRow),source_order:targetRows.length});
   // The input is already buffered; explicitly let heartbeat timers and the
   // other lane run while scanning a season on the CPU-limited VPS.
   if(++records%256===0)await yieldToIo();
  }
 }catch(error){
  throw new DataCompletionError('completion_stored_source_invalid',`Saved source content is invalid (${error instanceof SourceError?error.code:'source_csv_invalid'}). Run normal analysis; the report was preserved.`);
 }finally{input.destroy();parser.destroy();}
 if(stableJson(targetRows)!==stableJson(saved.plays))throw new DataCompletionError('completion_pbp_snapshot_mismatch','Saved plays do not reproduce their immutable clean source. Run normal analysis.');
}

/** Complete missing live aggregates without rerunning or replacing saved R evidence. */
export async function completePendingGameData(gameId:string):Promise<DataCompletionResult>{
 assertGameId(gameId);
 const report=await getReport(gameId);
 if(!report)throw new DataCompletionError('completion_report_missing','A completed statistical report is required before aggregate completion. Run normal analysis.');
 const {game,revision}=report;
 const base={gameId,revisionId:revision.id,revisionNumber:revision.number,warnings:revision.analysis.warnings};
 if(getGameVerdict(revision.analysis.gameAudit).rating!==null){
  // Also resumes publication after a previous completion committed successfully
  // but failed before its normal, idempotent automatic-publication call finished.
  await maybeAutomaticDraft(gameId);
  return {...base,status:'already_complete'};
 }
 if(!isPendingGameData(revision.analysis))return {...base,status:'waiting',reasonCode:'not_aggregate_completion_candidate'};
 if(revision.analysis.gameAudit?.version!==GAME_AUDIT_VERSION)throw new DataCompletionError('completion_audit_version_mismatch','Upgrade the saved audit separately before completing its aggregate data.');
 const store=new LocalSnapshotStore(path.join(config.dataDir,'snapshots'));
 let saved:Awaited<ReturnType<typeof savedInputs>>;
 try{saved=await savedInputs(game,revision.sourceSnapshots,store);}
 catch(error){
  if(error instanceof SourceError)throw new DataCompletionError('completion_stored_source_invalid',`Saved source content is invalid (${error.code}). Run normal analysis; the report was preserved.`);
  throw error;
 }
 const {plays,sourceKind}=saved;
 const source=await ingestGameProfiles(game,store,plays);
 if(!completePair(source.profiles))return {...base,status:'waiting',warnings:source.warnings,reasonCode:source.warnings[0]?.split(':')[0]??'team_stats_incomplete'};
 await verifySavedPbp(game,saved,store);
 const historical=await loadGameProfileReference(path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'game-profiles.json'));
 let analysis=structuredClone(revision.analysis);
 analysis.gameAudit=buildGameAudit({game,plays,profiles:source.profiles,reference:historical.reference,referenceChecksum:historical.checksum,events:analysis.events});
 analysis.models=analysis.models.filter(model=>model.id!=='game-profile-audit');
 analysis.models.push({id:'game-profile-audit',version:analysis.gameAudit.version,checksum:historical.checksum,
  trainingWindow:`${historical.reference.startSeason}–${historical.reference.endSeason}; target comparisons use prior seasons only`,notes:'Descriptive fixed-pattern historical comparisons and play review triggers; no intent or misconduct inference.'});
 // All R, charting and schedule source inputs stay pinned to the saved revision.
 // Replace just the aggregate source, never attach both old and new season CSVs.
 const snapshots=[...revision.sourceSnapshots.filter(snapshot=>snapshot.provider!=='nflverse-team-stats'),...source.snapshots];
 analysis=applySpreadAudit(game,analysis,snapshots,await loadSpreadReference());
 analysis=applyExpectationsAudit(game,analysis,await loadExpectationsReference());
 analysis.warnings=[...new Set([...analysis.warnings.filter(warning=>!aggregateWarning(warning)&&!warning.startsWith('game_profile_reference_unavailable:')),...source.warnings])];
 if(getGameVerdict(analysis.gameAudit).rating===null)return {...base,status:'waiting',reasonCode:'completed_aggregates_rating_unavailable',warnings:analysis.warnings};
 let revisionSaved:Awaited<ReturnType<typeof saveAnalysis>>;
 try{revisionSaved=await saveAnalysis(game,plays,snapshots,analysis,sourceKind,{expectedBaseRevisionId:revision.id});}
 catch(error){if(error instanceof RevisionConflictError)return {...base,status:'stale',reasonCode:error.code};throw error;}
 await maybeAutomaticDraft(gameId);
 return {gameId,status:revisionSaved.created?'updated':'already_complete',revisionId:revisionSaved.id,revisionNumber:revisionSaved.number,warnings:analysis.warnings};
}
