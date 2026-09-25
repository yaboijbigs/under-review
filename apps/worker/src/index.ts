import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { statfs } from 'node:fs/promises';
import { config,log } from '@under-review/core/config';
import { query,pool } from '@under-review/core/db';
import { claimJob,enqueue,enqueueAnalysisIfIdle,finishJob,heartbeat,type Job } from '@under-review/core/jobs';
import { analyzeGame,syncSeason } from '@under-review/core/pipeline';
import { refreshGameAudit } from '@under-review/core/audit-refresh';
import { repairSourceRegressions } from '@under-review/core/repository';
import { createDraft,publishOutbox,recoverUnknownPublications } from '@under-review/core/publishing';
import { completePendingGameData } from '@under-review/core/data-completion';
import { completePendingRefereeData } from '@under-review/core/referee-completion';
import { schedulePendingGameData } from '@under-review/core/postgame-scheduler';

const workerId=`${hostname()}:${randomUUID()}`;let stopping=false;let lastSchedule=0;
const lanes=['fast','analysis'] as const;
const activeJobs=new Map<string,Job|null>(lanes.map(lane=>[lane,null]));
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const beat=setInterval(()=>{for(const lane of lanes)void heartbeat(`${workerId}:${lane}`,activeJobs.get(lane)?.id??null).catch(error=>log('heartbeat.failed',{lane,error}));},15000);
await Promise.all(lanes.map(lane=>heartbeat(`${workerId}:${lane}`,null)));
log('worker.started',{workerId,concurrency:1,fastConcurrency:1,staging:config.staging});
for(const repair of await repairSourceRegressions(config.season)){
 log('report.source-repair',repair);
 if(repair.status==='reconcile')await enqueueAnalysisIfIdle(repair.gameId,{preferRaw:false},`source-repair:${repair.gameId}:${repair.revisionId}`);
}
// Only the analysis lane can run R. The fast lane keeps data checks and X
// delivery responsive within the same container and existing resource limits.
async function runLane(lane:typeof lanes[number]){
const laneId=`${workerId}:${lane}`;
while(!stopping){
 try{
  if(lane==='fast'&&Date.now()-lastSchedule>60000){
   const current=new Date();const nearGames=(await query("SELECT 1 FROM games WHERE kickoff_at BETWEEN now()-interval '8 hours' AND now()+interval '2 hours' LIMIT 1")).rowCount;
   const interval=nearGames?5*60000:6*3600000;
   await enqueue('sync-season',null,{season:config.season},`schedule:${config.season}:${Math.floor(Date.now()/interval)}`);
   if(current.getUTCDay()===4&&current.getUTCHours()>=12)await enqueue('reconcile-week',null,{season:config.season},`thursday:${current.toISOString().slice(0,10)}`);
   await schedulePendingGameData(config.season);
   await recoverUnknownPublications();lastSchedule=Date.now();
  }
  const disk=await statfs(config.dataDir);const minimum=Number(process.env.MIN_FREE_DISK_BYTES??1073741824);
  if(disk.bavail*disk.bsize<minimum){log('worker.deferred',{reason:'disk_reserve'});await new Promise(r=>setTimeout(r,30000));continue;}
  const activeJob=await claimJob(laneId,lane);
  if(!activeJob){await new Promise(r=>setTimeout(r,config.workerPollMs));continue;}
  activeJobs.set(lane,activeJob);
  try{
  await heartbeat(laneId,activeJob.id);log('job.started',{id:activeJob.id,kind:activeJob.kind,gameId:activeJob.gameId,lane});
  try{
   switch(activeJob.kind){
    case 'sync-season':await syncSeason(Number(activeJob.payload.season??config.season));break;
    case 'analyze':if(!activeJob.gameId)throw new Error('Game required');await analyzeGame(activeJob.gameId,{backfill:activeJob.payload.backfill===true,preferRaw:activeJob.payload.preferRaw!==false});if(activeJob.payload.prepareDraft===true)await createDraft(activeJob.gameId);break;
    case 'refresh-audit':{
     if(!activeJob.gameId)throw new Error('Game required');
     try{await refreshGameAudit(activeJob.gameId);}
     catch(error){
      if(!(error instanceof Error)||!('code' in error)||error.code!=='source_downgrade')throw error;
      log('audit.clean-reconciliation',{gameId:activeJob.gameId});
      await analyzeGame(activeJob.gameId,{preferRaw:false,backfill:activeJob.payload.backfill===true});
     }
     if(activeJob.payload.prepareDraft===true)await createDraft(activeJob.gameId);
     break;
    }
    case 'publish':await publishOutbox(String(activeJob.payload.outboxId));break;
    case 'complete-data':{
     if(!activeJob.gameId)throw new Error('Game required');
     const result=await completePendingGameData(activeJob.gameId);
     log('game.data-completion',result);
     break;
    }
    case 'complete-referee':{
     if(!activeJob.gameId)throw new Error('Game required');
     const result=await completePendingRefereeData(activeJob.gameId);
     log('game.referee-completion',result);
     // A later check can retry an exhausted fallback; pending/running analysis
     // still coalesces even though each 15-minute check has its own job ID.
     if(result.status==='needs_analysis')await enqueueAnalysisIfIdle(activeJob.gameId,{preferRaw:false},`referee-reconcile:${activeJob.gameId}:${result.revisionId}:${activeJob.id}`);
     break;
    }
    case 'reconcile-week':for(const r of (await query("SELECT id FROM games WHERE season=$1 AND kickoff_at>now()-interval '8 days' AND kickoff_at<now() AND game_json->>'homeScore' IS NOT NULL AND game_json->>'awayScore' IS NOT NULL",[Number(activeJob.payload.season??config.season)])).rows)await enqueueAnalysisIfIdle(r.id,{preferRaw:false},`thursday-game:${r.id}:${new Date().toISOString().slice(0,10)}`);break;
    default:throw new Error('Unknown job kind');
   }
   await finishJob(activeJob);log('job.completed',{id:activeJob.id});
  }catch(error){await finishJob(activeJob,error);log('job.failed',{id:activeJob.id,error});}
  }finally{activeJobs.set(lane,null);}
 }catch(error){log('worker.error',{error});await new Promise(r=>setTimeout(r,10000));}
}
}
await Promise.all(lanes.map(runLane));
clearInterval(beat);await pool.end();log('worker.stopped');
