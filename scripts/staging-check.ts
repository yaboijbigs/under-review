import { pool } from '@under-review/core/db';
import { safeError } from '@under-review/core/config';
import { checkSiteReadiness } from './site-readiness.js';
try {
 console.log(JSON.stringify({event:'staging.check',...await checkSiteReadiness({staging:true})}));
}catch(error){console.error(JSON.stringify({event:'staging.check.failed',error:safeError(error)}));process.exitCode=1;}finally{await pool.end();}
