import path from 'node:path';
import { config,projectRoot } from './config.js';
import { query } from './db.js';
import type { Game,GameAudit,SourceSnapshot } from './contracts.js';
import { assertGameId,parseCsv,validateGameData,type ProviderRow } from './normalize.js';
import { LocalSnapshotStore,SourceError } from './sources.js';
import { getReport,saveAnalysis,stableJson } from './repository.js';
import { buildGameAudit,GAME_AUDIT_VERSION } from './game-audit.js';
import { loadGameProfileReference,normalizeGameProfiles,validateGameProfileFinality } from './game-profile-source.js';
import { applyOvertimeTimeline,loadOvertimeReference } from './overtime-integration.js';

export class AuditRefreshError extends Error {
 constructor(public readonly code:string,message:string){super(message);this.name='AuditRefreshError';}
}

const profileFields=['totalYards','opponentYards','penalties','penaltyYards','turnoverMargin'] as const;
function completeProfiles(game:Game,audit:GameAudit):boolean{
 return audit.profiles.length===2&&[game.homeTeam,game.awayTeam].every(team=>{
  const profile=audit.profiles.find(row=>row.team===team);const home=team===game.homeTeam;
  return !!profile&&profile.gameId===game.id&&profile.season===game.season&&profile.opponent===(home?game.awayTeam:game.homeTeam)
   &&profile.pointsFor===(home?game.homeScore:game.awayScore)&&profile.pointsAgainst===(home?game.awayScore:game.homeScore)
   &&profileFields.every(field=>profile[field]!==null&&Number.isFinite(profile[field]));
 });
}
const evidence=(snapshots:SourceSnapshot[])=>snapshots.map(({id,provider,checksum})=>({id,provider,checksum})).sort((a,b)=>a.id.localeCompare(b.id));

/** Audit upgrades reuse immutable evidence; only analyze jobs reconcile live sources. */
async function storedProfiles(game:Game,plays:ProviderRow[],sources:SourceSnapshot[],current:GameAudit|undefined){
 if(sources.length>1)throw new AuditRefreshError('audit_aggregate_snapshot_ambiguous','The report identifies multiple team-statistics snapshots; run normal analysis.');
 const snapshot=sources[0];
 if(!snapshot){
  if(current&&completeProfiles(game,current))throw new AuditRefreshError('audit_aggregate_snapshot_missing','The stored complete profiles have no immutable aggregate snapshot; the existing report was preserved.');
  return {profiles:[],warnings:['team_stats_snapshot_missing: No aggregate snapshot was recorded for this revision; source reconciliation remains a separate analysis job.']};
 }
 if(!/^[a-f0-9]{64}$/.test(snapshot.checksum)||snapshot.url!==`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`){
  throw new AuditRefreshError('audit_aggregate_snapshot_identity','The stored team-statistics snapshot does not identify the expected season and immutable content.');
 }
 const store=new LocalSnapshotStore(path.join(config.dataDir,'snapshots'));
 let bytes:Buffer;
 try{
  // The database may retain another host's path. Read only the canonical checksum
  // location in this runtime; LocalSnapshotStore.read verifies the original bytes.
  bytes=await store.read({...snapshot,path:path.join(store.root,'snapshots',`${snapshot.checksum}.csv`)});
 }catch{throw new AuditRefreshError('audit_aggregate_snapshot_unreadable','The original team-statistics snapshot is missing or fails its checksum; the existing report was preserved.');}
 try{
  const rows=parseCsv(bytes),profiles=normalizeGameProfiles(game,rows);
  validateGameProfileFinality(game,rows,profiles,plays);
  if(current&&completeProfiles(game,current)&&profiles.some(profile=>profileFields.some(field=>profile[field]===null)))throw new AuditRefreshError('audit_aggregate_snapshot_invalid','The stored aggregate evidence no longer reproduces its complete profiles; the existing report was preserved.');
  return {profiles,warnings:profiles.some(profile=>profileFields.some(field=>profile[field]===null))?['team_profile_fields_missing: Historical comparisons use only available aggregate fields.']:[]};
 }catch(error){
  if(error instanceof AuditRefreshError)throw error;
  if(current&&completeProfiles(game,current))throw new AuditRefreshError('audit_aggregate_snapshot_invalid','The original aggregate snapshot does not pass the current finality gate; the existing report was preserved.');
  // A previously withheld source (for example ambiguous fumble-TD scoring) stays
  // withheld after the same gate; no network request or guessed zero fills it in.
  return {profiles:[],warnings:[`${error instanceof SourceError?error.code:'team_stats_unavailable'}: Game-profile comparison awaits paired team statistics; play review remains available.`]};
 }
}

/** Add the descriptive audit to immutable, validated R inputs; never run R or publish. */
export async function refreshGameAudit(gameId:string):Promise<{gameId:string;id:string;number:number;created:boolean;sourceKind:'raw'|'clean';warnings:string[]}>{
 assertGameId(gameId);
 const report=await getReport(gameId);
 if(!report)throw new AuditRefreshError('audit_report_missing','A completed statistical report is required before refreshing its game audit.');
 const {game,revision}=report;
 const pbp=revision.sourceSnapshots.filter(source=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider));
 if(pbp.length!==1)throw new AuditRefreshError('audit_pbp_snapshot_ambiguous','The report must identify exactly one immutable play-by-play snapshot; run normal analysis.');
 const sourceKind=pbp[0].provider==='nflverse-raw-pbp'?'raw':'clean';
 const rows=(await query('SELECT snapshot_id,play_id,provider_order,data FROM plays WHERE game_id=$1 AND snapshot_id=$2 ORDER BY provider_order',[gameId,pbp[0].id])).rows;
 if(!rows.length||rows.some((row,index)=>row.snapshot_id!==pbp[0].id||row.provider_order!==index||String(row.data?.play_id)!==row.play_id)){
  throw new AuditRefreshError('audit_pbp_snapshot_mismatch','Stored plays do not match the report snapshot and original provider order; run normal analysis.');
 }
 const plays=rows.map(row=>row.data as ProviderRow);
 const validation=validateGameData(game,plays);
 if(!validation.valid)throw new AuditRefreshError('audit_pbp_incomplete',`Stored report inputs are not a complete final game: ${validation.issues.join(', ')}. Run normal analysis.`);
 let historical:Awaited<ReturnType<typeof loadGameProfileReference>>;
 try{historical=await loadGameProfileReference(path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'game-profiles.json'));}
 catch{throw new AuditRefreshError('audit_reference_unavailable','The fixed historical game-profile reference is unavailable or invalid.');}
 const current=revision.analysis.gameAudit;
 const withOvertime=applyOvertimeTimeline(game,plays,revision.analysis,await loadOvertimeReference());
 const auditModels=revision.analysis.models.filter(model=>model.id==='game-profile-audit');
 const aggregateSources=revision.sourceSnapshots.filter(source=>source.provider==='nflverse-team-stats');
 // This command upgrades the audit only. Fresh statistical/source reconciliation
 // remains the normal analysis job, including updates to already complete audits.
 if(current?.version===GAME_AUDIT_VERSION&&current.reference.checksum===historical.checksum&&current.reference.version===historical.reference.version
  &&completeProfiles(game,current)&&auditModels.length===1&&auditModels[0].version===GAME_AUDIT_VERSION&&auditModels[0].checksum===historical.checksum&&aggregateSources.length===1){
  if(stableJson(withOvertime)===stableJson(revision.analysis))return {gameId,id:revision.id,number:revision.number,created:false,sourceKind,warnings:revision.analysis.warnings};
  // An OT-only upgrade of an already current, complete audit needs no source fetch.
  const saved=await saveAnalysis(game,plays,revision.sourceSnapshots,withOvertime,sourceKind,{expectedBaseRevisionId:revision.id});
  return {gameId,...saved,sourceKind,warnings:withOvertime.warnings};
 }
 const source=await storedProfiles(game,plays,aggregateSources,current);
 const analysis=structuredClone(withOvertime);
 analysis.gameAudit=buildGameAudit({game,plays,profiles:source.profiles,reference:historical.reference,referenceChecksum:historical.checksum,events:analysis.events});
 analysis.models=[...analysis.models.filter(model=>model.id!=='game-profile-audit'),{id:'game-profile-audit',version:analysis.gameAudit.version,checksum:historical.checksum,
  trainingWindow:`${historical.reference.startSeason}–${historical.reference.endSeason}; target comparisons use prior seasons only`,notes:'Descriptive fixed-pattern historical comparisons and play review triggers; no intent or misconduct inference.'}];
 analysis.warnings=[...new Set([...analysis.warnings.filter(warning=>!/^(?:team_stats_|team_profile_|game_profile_reference_unavailable:)/.test(warning)),...source.warnings])];
 const snapshots=revision.sourceSnapshots;
 if(stableJson(analysis)===stableJson(revision.analysis)&&stableJson(evidence(snapshots))===stableJson(evidence(revision.sourceSnapshots))){
  return {gameId,id:revision.id,number:revision.number,created:false,sourceKind,warnings:analysis.warnings};
 }
 const saved=await saveAnalysis(game,plays,snapshots,analysis,sourceKind,{expectedBaseRevisionId:revision.id});
 return {gameId,...saved,sourceKind,warnings:analysis.warnings};
}
