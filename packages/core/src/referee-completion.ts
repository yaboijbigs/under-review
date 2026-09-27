import path from 'node:path';
import { config } from './config.js';
import { query } from './db.js';
import type { AnalysisResult,Game,SourceSnapshot } from './contracts.js';
import { assertGameId,normalizeSchedule,parseCsv,validateGameData,type ProviderRow } from './normalize.js';
import { LocalSnapshotStore,SOURCE_LICENSES,SourceError,sourceUrls } from './sources.js';
import { getReport,RevisionConflictError,saveAnalysis,stableJson } from './repository.js';
import { GAME_AUDIT_VERSION } from './game-audit.js';
import { gameExpectationsSchema } from './expectations-contracts.js';
import { EXPECTATIONS_VERSION,loadExpectationsReference } from './expectations.js';
import { applyExpectationsAudit } from './expectations-integration.js';
import { applySpreadAudit,loadSpreadReference } from './spread.js';
import { maybeAutomaticDraft } from './publishing.js';
import { getCachedRefereeAssignment,isAssignmentSnapshot } from './referee-assignments.js';
import type { RefereeAssignment } from './referee-assignment-contracts.js';

export class RefereeCompletionError extends Error {
 constructor(public readonly code:string,message:string){super(message);this.name='RefereeCompletionError';}
}
export type RefereeCompletionResult={
 gameId:string;status:'waiting'|'updated'|'already_complete'|'stale'|'needs_analysis';
 revisionId?:string;revisionNumber?:number;reasonCode?:string;warnings:string[];
};
/** A known official with sparse history is complete metadata, not missing data. */
export function isPendingRefereeData(analysis:AnalysisResult):boolean {
 const parsed=gameExpectationsSchema.safeParse(analysis.gameAudit?.expectations);
 return analysis.gameAudit?.version===GAME_AUDIT_VERSION&&parsed.success&&parsed.data.version===EXPECTATIONS_VERSION
  &&((parsed.data.referee.status==='missing'&&parsed.data.referee.name===null)
   ||parsed.data.referee.status==='reported'||(parsed.data.referee.status==='conflict'&&!!parsed.data.referee.assignment));
}
const withoutReferee=(game:Game)=>({...game,providerData:Object.fromEntries(Object.entries(game.providerData).filter(([key])=>key!=='referee'))});
const named=(value:unknown)=>typeof value==='string'&&!!value.trim();
const assignmentEvidence=(assignment:RefereeAssignment|undefined)=>{
 if(!assignment)return undefined;
 const {name:derivedName,...evidence}=assignment;return evidence;
};

/** Enrich only the referee field; all factual schedule changes require normal analysis. */
export async function completePendingRefereeData(gameId:string):Promise<RefereeCompletionResult>{
 assertGameId(gameId);
 const report=await getReport(gameId);
 if(!report)throw new RefereeCompletionError('referee_report_missing','A completed statistical report is required before referee completion.');
 const {game,revision}=report;
 const base={gameId,revisionId:revision.id,revisionNumber:revision.number,warnings:revision.analysis.warnings};
 const previousAssignment=revision.analysis.gameAudit?.expectations?.referee.assignment;
 const cached=await getCachedRefereeAssignment(game,{assignment:previousAssignment,snapshots:revision.sourceSnapshots});
 // The displayed name may be canonicalized (Ron/Ronald Torbert). Compare raw
 // source evidence so aliases do not suppress the later nflverse reconciliation.
 const assignmentChanged=stableJson(assignmentEvidence(cached.assignment))!==stableJson(assignmentEvidence(previousAssignment));
 if(!isPendingRefereeData(revision.analysis)&&!assignmentChanged){
  const referee=revision.analysis.gameAudit?.expectations?.referee;
  if(referee&&['verified','schedule_only','reported'].includes(referee.status)&&named(referee.name))await maybeAutomaticDraft(gameId);
  return {...base,status:'already_complete',reasonCode:'not_missing_referee_candidate'};
 }
 if(named(game.providerData.referee)&&revision.analysis.gameAudit?.expectations?.referee.status==='missing')return {...base,status:'needs_analysis',reasonCode:'stored_referee_expectation_mismatch'};
 const schedules=revision.sourceSnapshots.filter(source=>source.provider==='nflverse-schedules');
 const pbp=revision.sourceSnapshots.filter(source=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider));
 if(schedules.length!==1||pbp.length!==1||schedules[0].url!==sourceUrls.schedules||!/^[a-f0-9]{64}$/.test(schedules[0].checksum))return {...base,status:'needs_analysis',reasonCode:'referee_saved_source_ambiguous'};
 const store=new LocalSnapshotStore(path.join(config.dataDir,'snapshots'),{timeoutMs:8000,maxBytes:8*1024*1024});
 let fresh:SourceSnapshot=schedules[0],freshGame:Game=game;
 // New cached evidence is usable immediately, including during a schedule outage.
 // Subsequent 15-minute checks reconcile it against nflverse's later assignment.
 if(!assignmentChanged)try{
  fresh=await store.fetch({provider:'nflverse-schedules',url:sourceUrls.schedules,license:SOURCE_LICENSES.nflverse,extension:'csv',metadata:{attribution:'Lee Sharpe and nflverse',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'}});
  const rows=parseCsv(await store.read(fresh)).filter(row=>row.game_id===gameId);
  if(rows.length!==1)return {...base,status:'waiting',reasonCode:'referee_schedule_game_unavailable'};
  freshGame=normalizeSchedule(rows[0]);
 }catch(error){
  if(error instanceof SourceError)return {...base,status:'waiting',reasonCode:error.code};
  throw error;
 }
 if(stableJson(withoutReferee(freshGame))!==stableJson(withoutReferee(game)))return {...base,status:'needs_analysis',reasonCode:'referee_schedule_facts_changed'};
 if(!named(freshGame.providerData.referee)&&!cached.assignment&&!previousAssignment)return {...base,status:'waiting',reasonCode:'referee_still_missing'};
 const expectations=await loadExpectationsReference(),spread=await loadSpreadReference();
 if(!revision.analysis.gameAudit?.expectations||revision.analysis.gameAudit.expectations.reference.checksum!==expectations.checksum||revision.analysis.gameAudit.market?.reference.checksum!==spread.checksum)return {...base,status:'needs_analysis',reasonCode:'referee_model_reference_changed'};
 const snapshots=[...revision.sourceSnapshots.filter(snapshot=>!isAssignmentSnapshot(snapshot)).map(snapshot=>snapshot.provider==='nflverse-schedules'?fresh:snapshot),...cached.snapshots];
 const analysis=applyExpectationsAudit(freshGame,applySpreadAudit(freshGame,revision.analysis,snapshots,spread),expectations,cached.assignment);
 if(stableJson(analysis.gameAudit?.expectations)===stableJson(revision.analysis.gameAudit.expectations)&&stableJson(freshGame)===stableJson(game)){
  await maybeAutomaticDraft(gameId);
  return {...base,status:'already_complete',reasonCode:'referee_evidence_unchanged'};
 }
 // Verify the old exact schedule only when new metadata is ready. A hybrid game
 // object would break immutable schedule provenance and future audit/bundle checks.
 try{
  const old=schedules[0],bytes=await store.read({...old,path:path.join(store.root,'snapshots',`${old.checksum}.csv`)});
  const rows=parseCsv(bytes).filter(row=>row.game_id===gameId);
  if(rows.length!==1||stableJson(normalizeSchedule(rows[0]))!==stableJson(game))return {...base,status:'needs_analysis',reasonCode:'referee_saved_schedule_mismatch'};
 }catch{return {...base,status:'needs_analysis',reasonCode:'referee_saved_schedule_unreadable'};}
 const sourceKind=pbp[0].provider==='nflverse-pbp'?'clean':'raw';
 if(pbp[0].url!==(sourceKind==='clean'?sourceUrls.clean(game.season):sourceUrls.raw(game.id))||!/^[a-f0-9]{64}$/.test(pbp[0].checksum))return {...base,status:'needs_analysis',reasonCode:'referee_pbp_source_mismatch'};
 const rows=(await query('SELECT snapshot_id,play_id,provider_order,data FROM plays WHERE game_id=$1 AND snapshot_id=$2 ORDER BY provider_order',[gameId,pbp[0].id])).rows;
 if(!rows.length||rows.some((row,index)=>row.snapshot_id!==pbp[0].id||row.provider_order!==index||String(row.data?.play_id)!==row.play_id))return {...base,status:'needs_analysis',reasonCode:'referee_pbp_snapshot_mismatch'};
 const plays=rows.map(row=>row.data as ProviderRow);
 if(!validateGameData(freshGame,plays).valid)return {...base,status:'needs_analysis',reasonCode:'referee_pbp_incomplete'};
 // The original PBP, charting, aggregates, R models, metrics, events and timeline
 // stay unchanged. Only expectations and the market's schedule attribution change.
 // Conflicts are saved explicitly and fall back to the calibrated team/opponent
 // model; retaining a now-disputed referee effect would misrepresent the evidence.
 let saved:Awaited<ReturnType<typeof saveAnalysis>>;
 try{saved=await saveAnalysis(freshGame,plays,snapshots,analysis,sourceKind,{expectedBaseRevisionId:revision.id});}
 catch(error){if(error instanceof RevisionConflictError)return {...base,status:'stale',reasonCode:error.code};throw error;}
 // Existing automatic-post eligibility and uniqueness remain authoritative; this
 // does not create correction posts or resend an already published initial post.
 await maybeAutomaticDraft(gameId);
 return {gameId,status:saved.created?'updated':'already_complete',revisionId:saved.id,revisionNumber:saved.number,warnings:analysis.warnings};
}
