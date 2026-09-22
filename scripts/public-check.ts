import { getReport } from '@under-review/core/repository';
import { getGameVerdict } from '@under-review/core/consumer-summary';
import { pool } from '@under-review/core/db';
import { safeError } from '@under-review/core/config';

try {
 const games=(process.env.SEED_GAMES??'').split(',').filter(Boolean);
 if(!games.length)throw new Error('Public readiness requires at least one seed report.');
 const deadline=Date.now()+1800000;
 let ready=false;
 while(Date.now()<deadline){
  const reports=await Promise.all(games.map(id=>getReport(id)));
  const pending=games.filter((_,i)=>{
   const r=reports[i];const audit=r?.revision.analysis.gameAudit;
   return !r||!audit||!r.revision.analysis.metrics.some(m=>m.status==='supported')
    ||(r.game.id==='2026_02_GB_NYJ'&&getGameVerdict(audit).level!=='highly_unusual');
  });
  if(!pending.length){ready=true;break;}
  console.log(JSON.stringify({event:'public.awaiting_reports',games:pending}));
  await new Promise(resolve=>setTimeout(resolve,30000));
 }
 if(!ready)throw new Error('Seed reports did not become ready within 30 minutes.');
 for(const id of games){
  const response=await fetch(`http://web:3000/games/${id}`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Seed report returned ${response.status}.`);
 }
 // Existing schema-validated reports remain readable while audit upgrades run.
 // The separate coverage service requires the current audit version on all games.
 // Website readiness is independent of social drafts and manual officiating reviews.
 // The existing check still verifies that live social publication is disabled.
 await import('./staging-check.js');
}catch(error){console.error(JSON.stringify({event:'public.check.failed',error:safeError(error)}));process.exitCode=1;await pool.end().catch(()=>{});}
