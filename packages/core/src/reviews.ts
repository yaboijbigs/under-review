import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query,transaction,audit } from './db.js';
import { contentHash,currentReviews,reviewCoverageStatus,reviewSnapshot,reviewSummary } from './repository.js';
import { reportSummary } from './summaries.js';
import type { AnalysisResult,Game } from './contracts.js';
import type { Session } from './auth.js';

const evidenceUrl=z.string().url().refine(v=>['https:','http:'].includes(new URL(v).protocol));
export const reviewInputSchema=z.object({gameId:z.string().min(1),eventId:z.string().min(1),status:z.enum(['not_reviewed','supported','likely_incorrect','debatable','insufficient_evidence']),ruleSeason:z.coerce.number().int().min(1999).max(2100),ruleReference:z.string().min(3).max(1000),evidenceUrl,rationale:z.string().min(10).max(10000),confidence:z.enum(['low','medium','high']),scope:z.string().min(10).max(2000),scopeComplete:z.boolean().default(false),replayCorrected:z.boolean().default(false)}).refine(review=>!review.scopeComplete||review.status!=='not_reviewed',{message:'A scope cannot be marked complete while the event is not reviewed.',path:['scopeComplete']});
export async function saveReview(input:unknown,session:Session){
 const review=reviewInputSchema.parse(input);
 const event=(await query('SELECT e.id,g.season FROM events e JOIN games g ON g.id=e.game_id WHERE e.id=$1 AND e.game_id=$2',[review.eventId,review.gameId])).rows[0];if(!event||event.season!==review.ruleSeason)throw new Error('Review must reference an event and the correct rule season.');
 const revision=(await query('SELECT id FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC LIMIT 1',[review.gameId])).rows[0];if(!revision)throw new Error('Report required.');
 const id=randomUUID();await query(`INSERT INTO reviews(id,event_id,revision_id,reviewer_id,status,rule_season,rule_reference,evidence_url,rationale,confidence,scope,replay_corrected,scope_complete)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,review.eventId,revision.id,session.userId,review.status,review.ruleSeason,review.ruleReference,review.evidenceUrl,review.rationale,review.confidence,review.scope,review.replayCorrected,review.scopeComplete]);
 await publishReviewRevision(review.gameId,'A reviewer added a scoped assessment; it is not an approved error finding.');await audit(session.userId,'review.created',id);return id;
}
export async function approveReview(id:string,session:Session){
 if(session.role!=='admin')throw new Error('Administrator required.');
 const row=(await query(`SELECT r.*,e.game_id,EXISTS(SELECT 1 FROM reviews newer WHERE newer.event_id=r.event_id AND newer.reviewer_id=r.reviewer_id AND (newer.created_at,newer.id)>(r.created_at,r.id)) AS superseded FROM reviews r JOIN events e ON e.id=r.event_id WHERE r.id=$1`,[id])).rows[0];if(!row||row.stale||row.superseded)throw new Error('Review is missing, stale, or superseded. Approve the latest assessment of current evidence.');
 if(row.approved)return;
 await query('UPDATE reviews SET approved=true,approved_by=$2 WHERE id=$1',[id,session.userId]);await publishReviewRevision(row.game_id,'An administrator approved a scoped review finding.');await audit(session.userId,'review.approved',id);
}
export async function insertMissedEvent(input:{gameId:string;playId:string;description:string;team:string|null},session:Session){
 if(input.description.length<10||input.description.length>10000)throw new Error('Provide a 10–10000 character description.');
 const play=(await query('SELECT data FROM plays WHERE game_id=$1 AND play_id=$2 LIMIT 1',[input.gameId,input.playId])).rows[0]?.data;if(!play)throw new Error('The play must exist in an ingested game.');
 const game:Game=(await query('SELECT game_json FROM games WHERE id=$1',[input.gameId])).rows[0]?.game_json;
 if(input.team&&![game.homeTeam,game.awayTeam].includes(input.team))throw new Error('Team must belong to the game.');
 const id=`${input.gameId}:${input.playId}`;const existing=(await query('SELECT data FROM events WHERE id=$1',[id])).rows[0]?.data;
 const data={...(existing??{id,playId:input.playId,quarter:play.qtr??null,clock:play.time??null,description:String(play.desc??'Recorded play'),kind:'missed_call_candidate',team:input.team,reviewStatus:'not_reviewed'}),notes:[...new Set([...(existing?.notes??[]),`Unreviewed candidate from ${session.username}: ${input.description}`])]};
 await query('INSERT INTO events(id,game_id,play_id,manual,data) VALUES($1,$2,$3,true,$4) ON CONFLICT(id) DO UPDATE SET manual=true,data=excluded.data',[id,input.gameId,input.playId,JSON.stringify(data)]);await publishReviewRevision(input.gameId,'A manual missed-call candidate was added to the existing underlying play; correctness has not been established.');await audit(session.userId,'event.inserted',id);return id;
}
export async function publishReviewRevision(gameId:string,reason:string){
 await transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`revision:${gameId}`]);
  const previous=(await client.query('SELECT * FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC LIMIT 1',[gameId])).rows[0];if(!previous)throw new Error('Report required.');
  const reviews=await reviewSnapshot(client,gameId);const analysis:AnalysisResult=structuredClone(previous.analysis);
  for(const r of (await client.query('SELECT data FROM events WHERE game_id=$1 AND manual=true',[gameId])).rows){const existing=analysis.events.find(e=>e.id===r.data.id);if(!existing)analysis.events.push(r.data);else existing.notes=r.data.notes;}
  const current=currentReviews(reviews);for(const event of analysis.events){const statuses=[...new Set(current.filter(review=>review.eventId===event.id&&review.status!=='not_reviewed').map(review=>review.status))];event.reviewStatus=statuses.length>1?'debatable':statuses[0]??'not_reviewed';}
  const hash=contentHash({base:previous.input_hash,reviews,events:analysis.events});const id=randomUUID();
  await client.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,review_status,change_summary,summary,analysis,snapshot_ids,game_json,reviews_json)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,gameId,previous.number+1,hash,previous.statistical_status,previous.charting_status,reviewCoverageStatus(reviews),reason,reportSummary(previous.game_json,analysis).replace('Officiating correctness: not reviewed.',reviewSummary(reviews)),JSON.stringify(analysis),JSON.stringify(previous.snapshot_ids),JSON.stringify(previous.game_json),JSON.stringify(reviews)]);
  for(const event of analysis.events)await client.query('INSERT INTO event_observations(event_id,revision_id,data) VALUES($1,$2,$3)',[event.id,id,JSON.stringify(event)]);
  await client.query('INSERT INTO metric_results(revision_id,metric_id,category,data) SELECT $1,metric_id,category,data FROM metric_results WHERE revision_id=$2',[id,previous.id]);
 });
}
