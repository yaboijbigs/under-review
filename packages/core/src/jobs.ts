import { randomUUID } from 'node:crypto';
import { query,transaction } from './db.js';
import { safeError } from './config.js';
import type pg from 'pg';

export interface Job {id:string;kind:string;gameId:string|null;payload:Record<string,unknown>;attempts:number;maxAttempts:number;workerId:string}
export const FAST_JOB_KINDS=['sync-season','reconcile-week','complete-data','complete-referee','publish'] as const;
export type WorkerLane='all'|'fast'|'analysis';
export async function enqueue(kind:string,gameId:string|null,payload:Record<string,unknown>={},key?:string,runAfter=new Date()):Promise<string>{
 const id=randomUUID();const result=await query(`INSERT INTO jobs(id,kind,game_id,job_key,payload,run_after) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(job_key) DO UPDATE SET job_key=excluded.job_key RETURNING id`,[id,kind,gameId,key??`${kind}:${gameId}:${id}`,JSON.stringify(payload),runAfter]);return result.rows[0].id;
}
/** One outstanding lightweight data check per game, including a delayed retry. */
export async function enqueueDataCompletionIfIdle(gameId:string,key:string):Promise<string>{
 return enqueueCompletionIfIdle('complete-data',gameId,key);
}
export async function enqueueRefereeCompletionIfIdle(gameId:string,key:string):Promise<string>{
 return enqueueCompletionIfIdle('complete-referee',gameId,key);
}
async function enqueueCompletionIfIdle(kind:'complete-data'|'complete-referee',gameId:string,key:string):Promise<string>{
 return transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`job:${gameId}`]);
  const existing=(await client.query("SELECT id FROM jobs WHERE game_id=$1 AND kind=$2 AND status IN ('pending','running') ORDER BY created_at LIMIT 1",[gameId,kind])).rows[0];
  if(existing)return existing.id;
  const result=await client.query("INSERT INTO jobs(id,kind,game_id,job_key,payload,run_after) VALUES($1,$2,$3,$4,'{}',now()) ON CONFLICT(job_key) DO UPDATE SET job_key=excluded.job_key RETURNING id",[randomUUID(),kind,gameId,key]);
  return result.rows[0].id;
 });
}
/** Scheduler/catchup coalescing; explicit future reconciliation jobs still use enqueue. */
export async function enqueueAnalysisIfIdle(gameId:string,payload:Record<string,unknown>={},key?:string,runAfter=new Date()):Promise<string>{
 return transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`job:${gameId}`]);
  // Calls can acquire the lock out of invocation order. Compare with the actual
  // time after acquiring it, so a concurrent due-now job is never mistaken for
  // future reconciliation because its caller's timestamp is a millisecond newer.
  const existing=(await client.query("SELECT id,status FROM jobs WHERE game_id=$1 AND kind='analyze' AND (status='running' OR (status='pending' AND run_after<=GREATEST($2::timestamptz,clock_timestamp()))) ORDER BY run_after,created_at LIMIT 1",[gameId,runAfter])).rows[0];
  if(existing){
   // Coalescing must never preserve a stale raw preference over reconciliation.
   if(existing.status==='pending'&&payload.preferRaw===false)await client.query("UPDATE jobs SET payload=payload||'{\"preferRaw\":false}'::jsonb,updated_at=now() WHERE id=$1",[existing.id]);
   return existing.id;
  }
  const id=randomUUID();
  const result=await client.query(`INSERT INTO jobs(id,kind,game_id,job_key,payload,run_after) VALUES($1,'analyze',$2,$3,$4,$5)
   ON CONFLICT(job_key) DO UPDATE SET job_key=excluded.job_key RETURNING id`,[id,gameId,key??`analyze:${gameId}:${id}`,JSON.stringify(payload),runAfter]);
  return result.rows[0].id;
 });
}
/** Recover abandoned work before queue planning as well as before claiming it. */
export async function recoverExpiredJobs(client?:pg.PoolClient){
 const sql="UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,worker_id=null,lease_until=null,error='Worker lease expired',updated_at=now() WHERE status='running' AND lease_until<now()";
 return client?client.query(sql):query(sql);
}
export async function claimJob(workerId:string,lane:WorkerLane='all'):Promise<Job|null>{
 return transaction(async client=>{
  // Sending posts are reconciled separately and never replayed by job recovery.
  await recoverExpiredJobs(client);
  const row=(await client.query(`SELECT * FROM jobs j WHERE status='pending' AND run_after<=now()
  AND ($1='all' OR ($1='fast' AND j.kind=ANY($2::text[])) OR ($1='analysis' AND NOT(j.kind=ANY($2::text[]))))
  AND (game_id IS NULL OR NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.game_id=j.game_id AND busy.status='running'))
  ORDER BY CASE
   WHEN j.kind IN ('sync-season','reconcile-week') THEN 0
   WHEN j.kind='publish' THEN 1
   WHEN j.kind IN ('complete-data','complete-referee') THEN 2
   WHEN j.kind='analyze' AND EXISTS(
    SELECT 1 FROM games g WHERE g.id=j.game_id AND g.kickoff_at BETWEEN now()-interval '36 hours' AND now()
     AND NOT EXISTS(SELECT 1 FROM analysis_revisions r WHERE r.game_id=g.id)
   ) THEN 2
   ELSE 3 END,j.run_after,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[lane,FAST_JOB_KINDS])).rows[0];
  if(!row)return null;
  if(row.game_id){const lock=(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[`job:${row.game_id}`])).rows[0];if(!lock.acquired)return null;
   if((await client.query("SELECT 1 FROM jobs WHERE game_id=$1 AND status='running'",[row.game_id])).rowCount)return null;
  }
  await client.query("UPDATE jobs SET status='running',attempts=attempts+1,worker_id=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",[row.id,workerId]);
  return {id:row.id,kind:row.kind,gameId:row.game_id,payload:row.payload,attempts:row.attempts+1,maxAttempts:row.max_attempts,workerId};
 });
}
export async function heartbeat(workerId:string,jobId:string|null){
 await query('INSERT INTO worker_heartbeats(id,job_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET updated_at=now(),job_id=excluded.job_id',[workerId,jobId]);
 if(jobId)await query("UPDATE jobs SET lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='running'",[jobId,workerId]);
}
export async function finishJob(job:Job,error?:unknown){
 if(!error){await query("UPDATE jobs SET status='succeeded',lease_until=null,updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='running'",[job.id,job.workerId]);return;}
 const delay=Math.min(3600,30*2**(job.attempts-1));
 await query("UPDATE jobs SET status=$3,error=$4,run_after=now()+make_interval(secs=>$5),lease_until=null,worker_id=null,updated_at=now() WHERE id=$1 AND worker_id=$2",[job.id,job.workerId,job.attempts>=job.maxAttempts?'failed':'pending',safeError(error),delay]);
}
