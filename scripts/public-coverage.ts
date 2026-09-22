import { getSeasonCoverage } from '@under-review/core/season-coverage';
import { GAME_AUDIT_VERSION } from '@under-review/core/game-audit';
import { pool } from '@under-review/core/db';
import { safeError } from '@under-review/core/config';

try {
 const deadline=Date.now()+3600000;
 let ready=false;
 while(Date.now()<deadline){
  const games=await getSeasonCoverage(2026,[1,2]);
  const completed=games.filter(g=>g.homeScore!==null&&g.awayScore!==null);
  const missing=completed.filter(g=>g.auditVersion!==GAME_AUDIT_VERSION);
  console.log(JSON.stringify({event:'coverage.progress',scheduled:games.length,completed:completed.length,audited:completed.length-missing.length,missing,awaiting:games.filter(g=>g.homeScore===null||g.awayScore===null).map(g=>g.id)}));
  ready=games.length===32&&completed.length===32&&missing.length===0;
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,60000));
 }
 if(!ready)throw new Error('Week 1–2 coverage did not become ready within one hour.');
}catch(error){console.error(JSON.stringify({event:'coverage.failed',error:safeError(error)}));process.exitCode=1;}
finally{await pool.end();}
