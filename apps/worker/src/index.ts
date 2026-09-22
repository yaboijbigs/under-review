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

const workerId=`${hostname()}:${randomUUID()}`;let stopping=false;let activeJob:Job|null=null;let lastSchedule=0;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const beat=setInterval(()=>{void heartbeat(workerId,activeJob?.id??null).catch(error=>log('heartbeat.failed',{error}));},15000);
await heartbeat(workerId,null);
log('worker.started',{workerId,concurrency:1,staging:config.staging});
for(const repair of await repairSourceRegressions(config.season)){
 log('report.source-repair',repair);
 if(repair.status==='reconcile')await enqueueAnalysisIfIdle(repair.gameId,{preferRaw:false},`source-repair:${repair.gameId}:${repair.revisionId}`);
}
while(!stopping){
 try{
  if(Date.now()-lastSchedule>60000){
   const current=new Date();const nearGames=(await query("SELECT 1 FROM games WHERE kickoff_at BETWEEN now()-interval '8 hours' AND now()+interval '2 hours' LIMIT 1")).rowCount;
   const interval=nearGames?5*60000:6*3600000;
   await enqueue('sync-season',null,{season:config.season},`schedule:${config.season}:${Math.floor(Date.now()/interval)}`);
   if(current.getUTCDay()===4&&current.getUTCHours()>=12)await enqueue('reconcile-week',null,{season:config.season},`thursday:${current.toISOString().slice(0,10)}`);
   await recoverUnknownPublications();lastSchedule=Date.now();
  }
  const disk=await statfs(config.dataDir);const minimum=Number(process.env.MIN_FREE_DISK_BYTES??1073741824);
  if(disk.bavail*disk.bsize<minimum){log('worker.deferred',{reason:'disk_reserve'});await new Promise(r=>setTimeout(r,30000));continue;}
  activeJob=await claimJob(workerId);
  if(!activeJob){await new Promise(r=>setTimeout(r,config.workerPollMs));continue;}
  await heartbeat(workerId,activeJob.id);log('job.started',{id:activeJob.id,kind:activeJob.kind,gameId:activeJob.gameId});
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
    case 'reconcile-week':for(const r of (await query("SELECT id FROM games WHERE season=$1 AND kickoff_at>now()-interval '8 days' AND kickoff_at<now() AND game_json->>'homeScore' IS NOT NULL AND game_json->>'awayScore' IS NOT NULL",[Number(activeJob.payload.season??config.season)])).rows)await enqueueAnalysisIfIdle(r.id,{preferRaw:false},`thursday-game:${r.id}:${new Date().toISOString().slice(0,10)}`);break;
    default:throw new Error('Unknown job kind');
   }
   await finishJob(activeJob);log('job.completed',{id:activeJob.id});
  }catch(error){await finishJob(activeJob,error);log('job.failed',{id:activeJob.id,error});}
  activeJob=null;
 }catch(error){log('worker.error',{error});await new Promise(r=>setTimeout(r,10000));}
}
clearInterval(beat);await pool.end();log('worker.stopped');
