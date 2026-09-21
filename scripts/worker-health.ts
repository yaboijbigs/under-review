import { query,pool } from '../packages/core/src/db.js';
try{const r=await query("SELECT 1 FROM worker_heartbeats WHERE updated_at>now()-interval '90 seconds' LIMIT 1");process.exitCode=r.rowCount?0:1;}catch{process.exitCode=1;}finally{await pool.end();}
