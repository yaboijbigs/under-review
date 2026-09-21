import { getReport,getOperationalStatus } from '@under-review/core/repository';
import { getPublishingSettings } from '@under-review/core/publishing';
import { pool } from '@under-review/core/db';
import { safeError } from '@under-review/core/config';
try {
 const origin=process.env.CHECK_ORIGIN??'http://web:3000';
 const results=[];
 for(const route of ['/','/methodology','/sources','/corrections','/status','/api/health','/api/ready','/robots.txt']){
  const response=await fetch(origin+route,{signal:AbortSignal.timeout(30000)});
  results.push({route,status:response.status});if(!response.ok)throw new Error(`Route ${route} returned ${response.status}`);
 }
 const publishing=await getPublishingSettings();
 if(!publishing.killSwitch||publishing.mode==='automatic')throw new Error('Staging publication guard is not enabled.');
 const reports=[];
 for(const gameId of (process.env.SEED_GAMES??'').split(',').filter(Boolean)){
  const report=await getReport(gameId);reports.push({gameId,revision:report?.revision.number??null,metrics:report?.revision.analysis.metrics.length??0,drafts:report?.drafts.length??0});
 }
 console.log(JSON.stringify({event:'staging.check',routes:results,reports,status:await getOperationalStatus(),livePosting:false}));
}catch(error){console.error(JSON.stringify({event:'staging.check.failed',error:safeError(error)}));process.exitCode=1;}finally{await pool.end();}
