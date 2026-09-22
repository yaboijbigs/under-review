import { migrate,pool,query } from '@under-review/core/db';
import { createUser } from '@under-review/core/auth';
import { enqueue,recoverExpiredJobs } from '@under-review/core/jobs';
import { syncSeason } from '@under-review/core/pipeline';
import { config,safeError } from '@under-review/core/config';
import { queueSeasonCatchup,validateCoverageScope } from '@under-review/core/season-coverage';

try {
  const auditWeeks=process.env.AUDIT_CATCHUP_WEEKS?.split(',').filter(Boolean).map(Number)??[];
  if(auditWeeks.length)validateCoverageScope(config.season,auditWeeks);
  await migrate();
  const username=process.env.UR_ADMIN_USERNAME??'owner';
  if(!(await query('SELECT 1 FROM users WHERE username=$1',[username])).rowCount){
    if(!process.env.UR_ADMIN_PASSWORD)throw new Error('Set UR_ADMIN_PASSWORD for initial account creation.');
    await createUser(username,process.env.UR_ADMIN_PASSWORD);
  }
  const seeds=(process.env.SEED_GAMES??'').split(',').filter(Boolean);
  for(const season of new Set(seeds.map(id=>Number(id.slice(0,4)))))await syncSeason(season,false);
  for(const id of seeds){
    if(!/^20\d{2}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(id))throw new Error('Invalid seed game ID.');
    await enqueue('analyze',id,{backfill:true,preferRaw:true,prepareDraft:true},`bootstrap:${id}`);
  }
  if(auditWeeks.length){
    await recoverExpiredJobs();
    const catchup=await queueSeasonCatchup(config.season,auditWeeks);
    console.log(JSON.stringify({event:'bootstrap.audit-catchup',season:config.season,weeks:auditWeeks,queued:catchup.queued}));
  }
  console.log(JSON.stringify({event:'bootstrap.complete',account:username,seedGames:seeds,livePosting:false}));
}catch(error){console.error(JSON.stringify({event:'bootstrap.failed',error:safeError(error)}));process.exitCode=1;}finally{await pool.end();}
