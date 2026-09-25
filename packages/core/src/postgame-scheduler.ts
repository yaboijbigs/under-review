import { query } from './db.js';
import { isPendingGameData } from './data-completion.js';
import { isPendingRefereeData } from './referee-completion.js';
import { enqueueDataCompletionIfIdle,enqueueRefereeCompletionIfIdle } from './jobs.js';

export const DATA_COMPLETION_INTERVAL_MS=15*60*1000;

/** Runs independently of full R analysis; referee assignments can arrive weeks later. */
export async function schedulePendingGameData(season:number,now=Date.now()):Promise<number>{
 const rows=(await query(`SELECT g.id,jsonb_build_object('warnings',r.analysis->'warnings','gameAudit',r.analysis->'gameAudit') AS analysis FROM games g
  JOIN LATERAL(SELECT analysis FROM analysis_revisions WHERE game_id=g.id ORDER BY number DESC LIMIT 1) r ON true
  WHERE g.season=$1 AND g.kickoff_at<=$2::timestamptz
   AND g.game_json->>'homeScore' IS NOT NULL AND g.game_json->>'awayScore' IS NOT NULL`,[season,new Date(now)])).rows;
 let pending=0;
 for(const row of rows){
  const bucket=Math.floor(now/DATA_COMPLETION_INTERVAL_MS);
  if(isPendingGameData(row.analysis)){
   await enqueueDataCompletionIfIdle(row.id,`complete-data:${row.id}:${bucket}`);
   pending++;
  }
  if(isPendingRefereeData(row.analysis)){
   await enqueueRefereeCompletionIfIdle(row.id,`complete-referee:${row.id}:${bucket}`);
   pending++;
  }
 }
 return pending;
}
