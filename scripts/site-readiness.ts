import { getReport,getOperationalStatus } from '@under-review/core/repository';
import { getPublishingSettings } from '@under-review/core/publishing';
import { config } from '@under-review/core/config';

/** Common read-only website checks; only the staging entry point applies its publication restriction. */
export async function checkSiteReadiness({staging,origin=process.env.CHECK_ORIGIN??'http://web:3000',games=(process.env.SEED_GAMES??'').split(',').filter(Boolean)}:{staging:boolean;origin?:string;games?:string[]}){
 const routes=[];
 for(const route of ['/','/methodology','/sources','/corrections','/status','/api/health','/api/ready','/robots.txt']){
  const response=await fetch(origin+route,{signal:AbortSignal.timeout(30000)});
  routes.push({route,status:response.status});if(!response.ok)throw new Error(`Route ${route} returned ${response.status}`);
 }
 const publishing=await getPublishingSettings();
 if(staging&&(!publishing.killSwitch||publishing.mode==='automatic'))throw new Error('Staging publication guard is not enabled.');
 const reports=[];
 for(const gameId of games){
  const report=await getReport(gameId);reports.push({gameId,revision:report?.revision.number??null,metrics:report?.revision.analysis.metrics.length??0,drafts:report?.drafts.length??0});
 }
 return {routes,reports,status:await getOperationalStatus(),livePosting:!config.staging&&config.livePostingAllowed&&!publishing.killSwitch&&publishing.mode==='automatic'};
}
