import { createHash,randomUUID } from 'node:crypto';
import { query,transaction } from './db.js';
import { config } from './config.js';
import { reportSummary } from './summaries.js';
import { analysisSchema,type AnalysisResult,type Draft,type Game,type GameCard,type GameReport,type Revision,type Review,type SourceSnapshot } from './contracts.js';
import type pg from 'pg';
import { validateGameData,type ProviderRow } from './normalize.js';

export function stableJson(value:unknown):string{
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
 return '{'+Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined).map(k=>JSON.stringify(k)+':'+stableJson((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const contentHash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
export function gameAuditCorrection(previous:AnalysisResult['gameAudit'],current:AnalysisResult['gameAudit']):boolean{
 if(!previous)return false;
 if(!current)return previous.flags.length>0||previous.profiles.some(p=>p.totalYards!==null);
 const fields=['totalYards','opponentYards','penalties','penaltyYards','turnoverMargin','nonOffensiveTouchdowns'] as const;
 const profileChanged=previous.profiles.some(p=>fields.some(key=>p[key]!==null&&p[key]!==current.profiles.find(n=>n.team===p.team)?.[key]));
 return profileChanged||(previous.flags.length>0&&stableJson(previous.flags)!==stableJson(current.flags));
}
function sourceEvent(event:Record<string,unknown>|undefined){if(!event)return null;const {reviewStatus,notes,...evidence}=event;return evidence;}
export async function saveGames(games:Game[],publicationEligible=false){
 await transaction(async client=>{for(const game of games)await client.query(`INSERT INTO games(id,season,week,game_type,home_team,away_team,kickoff_at,game_json,publication_eligible)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET game_json=excluded.game_json,kickoff_at=excluded.kickoff_at,updated_at=now()`,[game.id,game.season,game.week,game.gameType,game.homeTeam,game.awayTeam,game.kickoffAt,JSON.stringify(game),publicationEligible]);});
}
export async function getGame(id:string):Promise<Game|null>{return (await query('SELECT game_json FROM games WHERE id=$1',[id])).rows[0]?.game_json??null;}
export async function saveSnapshots(snapshots:SourceSnapshot[]){
 for(const s of snapshots)await query('INSERT INTO source_snapshots(id,provider,url,checksum,retrieved_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[s.id,s.provider,s.url,s.checksum,s.retrievedAt,JSON.stringify(s)]);
}
export async function reviewSnapshot(client:Pick<pg.PoolClient,'query'>,gameId:string):Promise<Review[]>{
 const rows=(await client.query(`SELECT r.*,u.username,e.play_id FROM reviews r JOIN users u ON u.id=r.reviewer_id JOIN events e ON e.id=r.event_id WHERE e.game_id=$1 ORDER BY r.created_at DESC,r.id DESC`,[gameId])).rows;
 return rows.map(r=>({id:r.id,eventId:r.event_id,playId:r.play_id,reviewer:r.username,status:r.status,ruleSeason:r.rule_season,ruleReference:r.rule_reference,evidenceUrl:r.evidence_url,rationale:r.rationale,confidence:r.confidence,scope:r.scope,scopeComplete:r.scope_complete===true,approved:r.approved,stale:r.stale,createdAt:r.created_at.toISOString(),replayCorrected:r.replay_corrected}));
}
export function currentReviews(reviews:Review[]):Review[]{
 const latest=new Map<string,Review>();
 // Pick the latest assessment before excluding stale records, so a superseded approval cannot reappear.
 for(const review of [...reviews].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){const key=JSON.stringify([review.eventId,review.reviewer]);if(!latest.has(key))latest.set(key,review);}
 return [...latest.values()].filter(review=>!review.stale);
}
export function reviewCoverageStatus(reviews:Review[]):Revision['reviewStatus']{
 const current=currentReviews(reviews).filter(review=>review.status!=='not_reviewed');
 if(!current.length)return 'not_reviewed';
 return current.some(review=>review.approved&&review.scopeComplete===true)?'reviewed_within_scope':'partially_reviewed';
}
export function reviewSummary(reviews:Review[]):string{
 const current=currentReviews(reviews).filter(review=>review.status!=='not_reviewed');
 if(!current.length)return 'Officiating correctness: not reviewed.';
 const approved=current.filter(review=>review.approved&&review.status==='likely_incorrect');
 const remaining=new Set(approved.filter(r=>!r.replayCorrected).map(r=>r.eventId)).size;
 const corrected=new Set(approved.filter(r=>r.replayCorrected).map(r=>r.eventId)).size;
 const scopes=[...new Set(current.filter(review=>review.approved&&review.scopeComplete===true).map(review=>review.scope))];
 const coverage=scopes.length?`Reviewed within these explicitly completed, approved scopes: ${scopes.map(scope=>JSON.stringify(scope)).join('; ')}.`:'Selected events partially reviewed; no completed scope has administrator approval.';
 return `${coverage} ${remaining} events have approved likely-incorrect findings whose effects remained; ${corrected} were corrected by replay. Review disagreements and reviewer counts are shown with the evidence. This is not whole-game coverage or a comprehensive error count.`;
}
export class RevisionConflictError extends Error {
 readonly code='revision_conflict';
 constructor(){super('The latest report changed during analysis; refresh from its new revision.');this.name='RevisionConflictError';}
}
export class SourceDowngradeError extends Error {
 readonly code='source_downgrade';
 constructor(){super('Clean play-by-play has already been analyzed. Reconcile with clean data instead of replacing it with raw data.');this.name='SourceDowngradeError';}
}
const meaningfulEvidence=(analysis:AnalysisResult)=>({metrics:analysis.metrics,timeline:analysis.timeline,coverage:analysis.coverage,
 gameAudit:analysis.gameAudit??null,events:analysis.events.map(event=>sourceEvent(event))});
/** Repair only a provably equivalent source regression; a real change needs fresh clean analysis. */
export async function repairSourceRegressions(season:number):Promise<{gameId:string;revisionId:string;status:'restored'|'reconcile';reason?:string}[]>{
 const candidates=(await query(`SELECT r.* FROM games g JOIN LATERAL(SELECT * FROM analysis_revisions WHERE game_id=g.id ORDER BY number DESC LIMIT 1) r ON true
  WHERE g.season=$1 AND r.source_kind='raw' AND EXISTS(SELECT 1 FROM analysis_revisions c WHERE c.game_id=g.id AND c.source_kind='clean')`,[season])).rows;
 const outcomes:{gameId:string;revisionId:string;status:'restored'|'reconcile';reason?:string}[]=[];
 for(const current of candidates){
  try{
   const clean=(await query("SELECT * FROM analysis_revisions WHERE game_id=$1 AND source_kind='clean' ORDER BY number DESC LIMIT 1",[current.game_id])).rows[0];
   const game=clean.game_json as Game;const currentGame=await getGame(game.id);
   if(!currentGame||[current.game_json,currentGame].some(other=>other.homeScore!==game.homeScore||other.awayScore!==game.awayScore))throw new Error('Final scores changed; fresh clean reconciliation required.');
   if(stableJson(meaningfulEvidence(clean.analysis))!==stableJson(meaningfulEvidence(current.analysis)))throw new Error('Reported findings changed; fresh clean reconciliation required.');
   const snapshots:SourceSnapshot[]=(await query('SELECT snapshot_json FROM source_snapshots WHERE id=ANY($1::text[])',[clean.snapshot_ids])).rows.map(row=>row.snapshot_json);
   const pbp=snapshots.filter(source=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider));
   if(snapshots.length!==clean.snapshot_ids.length||pbp.length!==1||pbp[0].provider!=='nflverse-pbp')throw new Error('Clean evidence provenance is incomplete.');
   const rows=(await query('SELECT play_id,provider_order,data FROM plays WHERE game_id=$1 AND snapshot_id=$2 ORDER BY provider_order',[game.id,pbp[0].id])).rows;
   if(!rows.length||rows.some((row,index)=>row.provider_order!==index||String(row.data?.play_id)!==row.play_id))throw new Error('Stored clean play order cannot be verified.');
   const plays=rows.map(row=>row.data as ProviderRow);const validation=validateGameData(game,plays);
   if(!validation.valid)throw new Error('Stored clean evidence is not a complete final game.');
   const restored=await persistAnalysis(game,plays,snapshots,clean.analysis,'clean',{expectedBaseRevisionId:current.id},clean.id);
   outcomes.push({gameId:game.id,revisionId:restored.id,status:'restored'});
  }catch(error){outcomes.push({gameId:current.game_id,revisionId:current.id,status:'reconcile',reason:error instanceof Error?error.message:'Clean evidence could not be verified.'});}
 }
 return outcomes;
}
export async function saveAnalysis(game:Game,plays:Record<string,unknown>[],snapshots:SourceSnapshot[],result:AnalysisResult,sourceKind:'raw'|'clean',options:{expectedBaseRevisionId?:string|null;preventPublication?:boolean}={}):Promise<{id:string;number:number;created:boolean}>{
 return persistAnalysis(game,plays,snapshots,result,sourceKind,options);
}
async function persistAnalysis(game:Game,plays:Record<string,unknown>[],snapshots:SourceSnapshot[],result:AnalysisResult,sourceKind:'raw'|'clean',options:{expectedBaseRevisionId?:string|null;preventPublication?:boolean}={},restoreFromRevisionId?:string):Promise<{id:string;number:number;created:boolean}>{
 const analysis=analysisSchema.parse(result);
 const knownPbp=snapshots.filter(source=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider));
 if(knownPbp.length&&(knownPbp.length!==1||(knownPbp[0].provider==='nflverse-pbp')!==(sourceKind==='clean')))throw new Error('PBP source provenance does not match its declared maturity.');
 let inputHash=contentHash({game,snapshots:snapshots.map(s=>({provider:s.provider,checksum:s.checksum})).sort((a,b)=>a.provider.localeCompare(b.provider)||a.checksum.localeCompare(b.checksum)),analysis,closeCallTolerance:config.closeCallTolerance});
 return transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`revision:${game.id}`]);
  const previous=(await client.query('SELECT * FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC LIMIT 1',[game.id])).rows[0];
  if(options.expectedBaseRevisionId!==undefined&&(previous?.id??null)!==options.expectedBaseRevisionId)throw new RevisionConflictError();
  if(sourceKind==='raw'&&(await client.query("SELECT 1 FROM analysis_revisions WHERE game_id=$1 AND source_kind='clean' LIMIT 1",[game.id])).rowCount)throw new SourceDowngradeError();
  if(options.preventPublication)await client.query('UPDATE games SET publication_eligible=false WHERE id=$1',[game.id]);
  const duplicate=await client.query('SELECT id,number,source_kind FROM analysis_revisions WHERE game_id=$1 AND input_hash=$2',[game.id,inputHash]);
  if(duplicate.rowCount&&!restoreFromRevisionId){
   if(sourceKind==='clean'&&previous?.source_kind==='raw'&&duplicate.rows[0].source_kind==='clean')restoreFromRevisionId=duplicate.rows[0].id;
   else return {id:previous.id,number:previous.number,created:false};
  }
  if(restoreFromRevisionId)inputHash=contentHash({inputHash,restoredFrom:restoreFromRevisionId,after:previous.id});
  // Guarded refreshes must not overwrite the current game or register stale sources
  // before checking their immutable base revision under the same transaction lock.
  await client.query(`INSERT INTO games(id,season,week,game_type,home_team,away_team,kickoff_at,game_json,publication_eligible)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(id) DO UPDATE SET game_json=excluded.game_json,kickoff_at=excluded.kickoff_at,updated_at=now()`,[game.id,game.season,game.week,game.gameType,game.homeTeam,game.awayTeam,game.kickoffAt,JSON.stringify(game)]);
  for(const s of snapshots)await client.query('INSERT INTO source_snapshots(id,provider,url,checksum,retrieved_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[s.id,s.provider,s.url,s.checksum,s.retrievedAt,JSON.stringify(s)]);
  // Human descriptions belong to the canonical play and survive routine source refreshes.
  // R only emits modeled candidates, so absence from R's event list is not deletion of a manual candidate.
  const currentPlays=new Map(plays.map(play=>[String(play.play_id),play]));
  const missingManualIds:string[]=[];
  for(const row of (await client.query('SELECT id,play_id,data FROM events WHERE game_id=$1 AND manual=true',[game.id])).rows){
   const existing=analysis.events.find(event=>event.id===row.id);
   if(existing){existing.notes=row.data.notes;continue;}
   const play=currentPlays.get(row.play_id);
   const candidate={...row.data,reviewStatus:'not_reviewed'};
   if(play){candidate.quarter=typeof play.qtr==='number'?play.qtr:candidate.quarter;candidate.clock=typeof play.time==='string'?play.time:candidate.clock;candidate.description=typeof play.desc==='string'?play.desc:candidate.description;}
   else{missingManualIds.push(row.id);candidate.notes=[...new Set([...(candidate.notes??[]),'Underlying play is absent from the current source; retained for history, not a current error finding.'])];}
   analysis.events.push(candidate);
  }
  const id=randomUUID();const number=(previous?.number??0)+1;
  const oldMetrics:AnalysisResult['metrics']=previous?.analysis?.metrics??[];
  const changes=analysis.metrics.filter(m=>stableJson(oldMetrics.find(x=>x.id===m.id))!==stableJson(m));
  const numericalChanges=changes.filter(m=>m.category!=='execution'&&oldMetrics.some(x=>x.id===m.id&&(x.value!==m.value||x.status!==m.status)));
  const charting=analysis.coverage.find(c=>c.category==='execution');
  const chartingStatus=charting?.status==='available'?'available':charting?.modeled?'partial':'unavailable';
  const scoreChanged=previous&&(previous.game_json.homeScore!==game.homeScore||previous.game_json.awayScore!==game.awayScore);
  const auditCorrection=gameAuditCorrection(previous?.analysis?.gameAudit,analysis.gameAudit);
  const status=previous&&(numericalChanges.length||scoreChanged||auditCorrection)?'corrected':sourceKind==='raw'?'preliminary':'reconciled';
  const auditChanged=previous&&stableJson(previous.analysis.gameAudit)!==stableJson(analysis.gameAudit);
  const changeSummary=restoreFromRevisionId?`Restored verified clean-source evidence from revision ${restoreFromRevisionId} after a later raw-data report. Original reports remain available; stale human reviews still require reassessment.`:!previous?'Initial evidence-backed report.':`${changes.length} metric records changed; ${numericalChanges.length} previously reported category findings changed. ${scoreChanged?'Final score corrected. ':''}${chartingStatus!==previous.charting_status?'Charting coverage updated. ':''}${auditCorrection?'Previously reported game profile or historical comparison corrected.':auditChanged?'Game profile audit and review priorities updated.':''}`.trim();
  const snapshotIds=snapshots.map(s=>s.id);
  await client.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json,source_kind)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,game.id,number,inputHash,status,chartingStatus,changeSummary,reportSummary(game,analysis),JSON.stringify(analysis),JSON.stringify(snapshotIds),JSON.stringify(game),sourceKind]);
  await client.query('UPDATE games SET first_validated_at=COALESCE(first_validated_at,now()) WHERE id=$1',[game.id]);
  const pbpSnapshot=snapshots.find(s=>/pbp|play/i.test(s.provider))??snapshots[0];
  if(pbpSnapshot)for(let i=0;i<plays.length;i++)await client.query('INSERT INTO plays(game_id,snapshot_id,play_id,provider_order,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[game.id,pbpSnapshot.id,String(plays[i].play_id),i,JSON.stringify(plays[i])]);
  for(const event of analysis.events){
   await client.query('INSERT INTO events(id,game_id,play_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[event.id,game.id,event.playId,JSON.stringify(event)]);
   await client.query('INSERT INTO event_observations(event_id,revision_id,data) VALUES($1,$2,$3)',[event.id,id,JSON.stringify(event)]);
  }
  for(const metric of analysis.metrics)await client.query('INSERT INTO metric_results(revision_id,metric_id,category,data) VALUES($1,$2,$3,$4)',[id,metric.id,metric.category,JSON.stringify(metric)]);
  for(const model of analysis.models)await client.query('INSERT INTO model_artifacts(id,version,manifest) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[model.id+':'+model.version,model.version,JSON.stringify(model)]);
  if(previous){
   const changedEventIds=analysis.events.filter(e=>stableJson(sourceEvent(previous.analysis.events.find((p:{id:string})=>p.id===e.id)))!==stableJson(sourceEvent(e))).map(e=>e.id);
   const removedEventIds=(previous.analysis.events as {id:string}[]).filter(e=>!analysis.events.some(n=>n.id===e.id)).map(e=>e.id);
   const affected=[...changedEventIds,...removedEventIds,...missingManualIds,...numericalChanges.flatMap(m=>m.eventIds)];
   if(affected.length)await client.query('UPDATE reviews SET stale=true WHERE event_id=ANY($1::text[])',[affected]);
  }
  const reviews=await reviewSnapshot(client,game.id);
  const current=currentReviews(reviews).filter(review=>review.status!=='not_reviewed');
  for(const event of analysis.events){const statuses=[...new Set(current.filter(review=>review.eventId===event.id).map(review=>review.status))];event.reviewStatus=statuses.length>1?'debatable':statuses[0]??'not_reviewed';}
  await client.query('UPDATE analysis_revisions SET reviews_json=$2,review_status=$3,summary=$4,analysis=$5 WHERE id=$1',[id,JSON.stringify(reviews),reviewCoverageStatus(reviews),reportSummary(game,analysis).replace('Officiating correctness: not reviewed.',reviewSummary(reviews)),JSON.stringify(analysis)]);
  return {id,number,created:true};
 });
}
export async function listGames(filters:{season?:number;week?:number;team?:string;publishedOnly?:boolean}={}):Promise<GameCard[]>{
 const values:unknown[]=[];const clauses:string[]=[];
 if(filters.season){values.push(filters.season);clauses.push(`g.season=$${values.length}`);}
 if(filters.week){values.push(filters.week);clauses.push(`g.week=$${values.length}`);}
 if(filters.team){values.push(filters.team);clauses.push(`(g.home_team=$${values.length} OR g.away_team=$${values.length})`);}
 if(filters.publishedOnly)clauses.push('r.number IS NOT NULL');
 const rows=(await query(`SELECT g.game_json,r.* FROM games g LEFT JOIN LATERAL(SELECT number,statistical_status,charting_status,review_status,summary,created_at,analysis->'gameAudit' AS game_audit FROM analysis_revisions WHERE game_id=g.id ORDER BY number DESC LIMIT 1) r ON true ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY g.week DESC,g.kickoff_at DESC NULLS LAST LIMIT 400`,values)).rows;
 return rows.map(r=>({...r.game_json,statisticalStatus:r.statistical_status??'awaiting_data',chartingStatus:r.charting_status??'unavailable',reviewStatus:r.review_status??'not_reviewed',finding:r.summary??null,updatedAt:r.created_at?.toISOString()??null,revisionNumber:r.number??null,gameAudit:r.game_audit??null}));
}
function mapDraft(r:Record<string,any>):Draft{return {id:r.id,gameId:r.game_id,revisionId:r.revision_id,text:r.text,status:r.status,kind:r.kind,mode:r.mode,createdAt:r.created_at.toISOString(),externalId:r.external_id,reason:r.reason};}
export async function getReport(gameId:string,revision?:number):Promise<GameReport|null>{
 const currentGame=await getGame(gameId);if(!currentGame)return null;
 const row=(await query(`SELECT * FROM analysis_revisions WHERE game_id=$1 ${revision?'AND number=$2':''} ORDER BY number DESC LIMIT 1`,revision?[gameId,revision]:[gameId])).rows[0];
 if(!row)return null;
 const game:Game=row.game_json;
 const [sourceRows,history,draftRows]=await Promise.all([
  query('SELECT snapshot_json FROM source_snapshots WHERE id=ANY($1::text[])',[row.snapshot_ids]),
  query('SELECT id,number,created_at,statistical_status,change_summary FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC',[gameId]),
  query('SELECT * FROM publication_outbox WHERE game_id=$1 ORDER BY created_at DESC',[gameId])
 ]);
 const rev:Revision={id:row.id,number:row.number,createdAt:row.created_at.toISOString(),statisticalStatus:row.statistical_status,chartingStatus:row.charting_status,reviewStatus:row.review_status,changeSummary:row.change_summary,analysis:row.analysis,inputHash:row.input_hash,sourceSnapshots:sourceRows.rows.map(r=>r.snapshot_json),summary:row.summary};
 return {game,revision:rev,history:history.rows.map(r=>({id:r.id,number:r.number,createdAt:r.created_at.toISOString(),statisticalStatus:r.statistical_status,changeSummary:r.change_summary})),reviews:row.reviews_json,drafts:draftRows.rows.map(mapDraft)};
}
export interface OperationalStatus {database:boolean;workerLastSeen:string|null;sources:{provider:string;retrievedAt:string}[];jobs:{status:string;count:number}[];staging:boolean;publishing:{mode:string;killSwitch:boolean};error?:string}
export async function getOperationalStatus():Promise<OperationalStatus>{
 try{
 const [worker,sources,jobs,publishing]=await Promise.all([query('SELECT max(updated_at) AS last FROM worker_heartbeats'),query('SELECT provider,max(retrieved_at) AS last FROM source_snapshots GROUP BY provider'),query('SELECT status,count(*)::integer AS count FROM jobs GROUP BY status'),query("SELECT value FROM settings WHERE key='publishing'")]);
 return {database:true,workerLastSeen:worker.rows[0]?.last?.toISOString()??null,sources:sources.rows.map(r=>({provider:r.provider,retrievedAt:r.last.toISOString()})),jobs:jobs.rows as OperationalStatus['jobs'],staging:config.staging,publishing:{mode:publishing.rows[0]?.value.mode??'draft-only',killSwitch:publishing.rows[0]?.value.killSwitch??true}};
 }catch{return {database:false,workerLastSeen:null,sources:[],jobs:[],staging:config.staging,publishing:{mode:'draft-only',killSwitch:true},error:'Database unavailable. Existing source files remain preserved.'};}
}
export async function listCorrections():Promise<{gameId:string;number:number;createdAt:string;changeSummary:string}[]>{return (await query("SELECT game_id,number,created_at,change_summary FROM analysis_revisions WHERE number>1 ORDER BY created_at DESC LIMIT 100")).rows.map(r=>({gameId:r.game_id,number:r.number,createdAt:r.created_at.toISOString(),changeSummary:r.change_summary}));}
export interface AdminOverview {jobs:Record<string,unknown>[];drafts:Draft[];reviews:Record<string,unknown>[];games:GameCard[];publishing:{mode:string;killSwitch:boolean;accountId:string|null;activatedAt:string|null};accounts:{id:string;username:string}[];status:OperationalStatus}
export async function getAdminOverview():Promise<AdminOverview>{
 const [jobs,drafts,reviews,games,publishing,accounts,status]=await Promise.all([query('SELECT id,kind,game_id AS "gameId",status,attempts,error,run_after AS "runAfter" FROM jobs ORDER BY created_at DESC LIMIT 50'),query('SELECT * FROM publication_outbox ORDER BY created_at DESC LIMIT 50'),query('SELECT r.id,r.event_id AS "eventId",r.status,r.approved,r.stale,r.rationale,r.scope,r.scope_complete AS "scopeComplete",u.username AS reviewer FROM reviews r JOIN users u ON u.id=r.reviewer_id ORDER BY r.created_at DESC LIMIT 50'),listGames(),query("SELECT value FROM settings WHERE key='publishing'"),query('SELECT id,username FROM oauth_accounts'),getOperationalStatus()]);
 return {jobs:jobs.rows,drafts:drafts.rows.map(mapDraft),reviews:reviews.rows,games,publishing:publishing.rows[0]?.value??{mode:'draft-only',killSwitch:true,accountId:null,activatedAt:null},accounts:accounts.rows as AdminOverview['accounts'],status};
}
