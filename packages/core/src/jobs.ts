import { randomUUID } from 'node:crypto';
import { query,transaction } from './db.js';
import { safeError } from './config.js';

export interface Job {id:string;kind:string;gameId:string|null;payload:Record<string,unknown>;attempts:number;maxAttempts:number;workerId:string}
export async function enqueue(kind:string,gameId:string|null,payload:Record<string,unknown>={},key?:string,runAfter=new Date()):Promise<string>{
 const id=randomUUID();const result=await query(`INSERT INTO jobs(id,kind,game_id,job_key,payload,run_after) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(job_key) DO UPDATE SET job_key=excluded.job_key RETURNING id`,[id,kind,gameId,key??`${kind}:${gameId}:${id}`,JSON.stringify(payload),runAfter]);return result.rows[0].id;
}
export async function claimJob(workerId:string):Promise<Job|null>{
 return transaction(async client=>{
  // Sending posts are reconciled separately and never replayed by job recovery.
  await client.query("UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,worker_id=null,lease_until=null,error='Worker lease expired',updated_at=now() WHERE status='running' AND lease_until<now()");
  const row=(await client.query(`SELECT * FROM jobs j WHERE status='pending' AND run_after<=now()
  AND (game_id IS NULL OR NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.game_id=j.game_id AND busy.status='running'))
  ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
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
