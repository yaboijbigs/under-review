import { query } from './db.js';
import { isPendingGameData } from './data-completion.js';
import { isPendingRefereeData } from './referee-completion.js';
import { enqueueDataCompletionIfIdle,enqueueRefereeCompletionIfIdle } from './jobs.js';

export const DATA_COMPLETION_INTERVAL_MS=15*60*1000;
export const NEAR_GAME_SYNC_INTERVAL_MS=5*60*1000;
export const QUIET_SEASON_SYNC_INTERVAL_MS=6*60*60*1000;

/** Keep source refreshes moving after kickoff until the first report exists. */
export async function hasRecentUnreportedGames(season:number,now=Date.now()):Promise<boolean>{
 const rows=(await query(`SELECT 1 FROM games g
  WHERE g.season=$1 AND g.kickoff_at >= $2::timestamptz-interval '8 days' AND g.kickoff_at<=$2::timestamptz
   AND NOT EXISTS(SELECT 1 FROM analysis_revisions r WHERE r.game_id=g.id)
  LIMIT 1`,[season,new Date(now)])).rows;
 return rows.length>0;
}

/** Near kickoffs stay fastest; recent games awaiting their first report get 15-minute source refreshes. */
export function seasonSyncIntervalMs(nearGames:boolean,recentUnreportedGames:boolean):number{
 return nearGames?NEAR_GAME_SYNC_INTERVAL_MS:recentUnreportedGames?DATA_COMPLETION_INTERVAL_MS:QUIET_SEASON_SYNC_INTERVAL_MS;
}

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
