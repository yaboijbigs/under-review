import { query } from './db.js';
import { enqueue } from './jobs.js';
import { GAME_AUDIT_VERSION } from './game-audit.js';

export interface CoverageGame {
 id:string;week:number;kickoffAt:string|null;homeScore:number|null;awayScore:number|null;
 revisionId:string|null;revision:number|null;statisticalStatus:string|null;auditVersion:string|null;auditStatus:string|null;
 jobs:{kind:string;status:string;attempts:number;error:string|null;key?:string}[];
}

export function validateCoverageScope(season:number,weeks:number[]):number[]{
 if(!Number.isInteger(season)||season<1999||season>2100)throw new Error('Choose an NFL season from 1999 through 2100.');
 const unique=[...new Set(weeks)].sort((a,b)=>a-b);
 if(!unique.length||unique.length>2||unique.some(week=>!Number.isInteger(week)||week<1||week>18))throw new Error('Coverage is limited to one or two explicit regular-season weeks (1–18).');
 return unique;
}

export async function getSeasonCoverage(season:number,weeks:number[]):Promise<CoverageGame[]>{
 const selected=validateCoverageScope(season,weeks);
 const result=await query(`SELECT g.id,g.week,g.kickoff_at,g.game_json,
  r.id AS revision_id,r.number,r.statistical_status,r.analysis->'gameAudit'->>'version' AS audit_version,
  r.analysis->'gameAudit'->>'status' AS audit_status,
  COALESCE(j.items,'[]'::jsonb) AS jobs
  FROM games g
  LEFT JOIN LATERAL(SELECT id,number,statistical_status,analysis FROM analysis_revisions WHERE game_id=g.id ORDER BY number DESC LIMIT 1) r ON true
  LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('kind',kind,'status',status,'attempts',attempts,'error',error,'key',job_key) ORDER BY run_after) AS items
    FROM jobs WHERE game_id=g.id AND status IN ('pending','running','failed')) j ON true
  WHERE g.season=$1 AND g.game_type='REG' AND g.week=ANY($2::integer[])
  ORDER BY g.week,g.kickoff_at,g.id`,[season,selected]);
 return result.rows.map(row=>({id:row.id,week:row.week,kickoffAt:row.kickoff_at?.toISOString()??null,
  homeScore:row.game_json.homeScore??null,awayScore:row.game_json.awayScore??null,revisionId:row.revision_id??null,
  revision:row.number??null,statisticalStatus:row.statistical_status??null,auditVersion:row.audit_version??null,
  auditStatus:row.audit_status??null,jobs:row.jobs}));
}

export function catchupKind(game:CoverageGame,now=Date.now()):'analyze'|'refresh-audit'|null{
 const kickoff=game.kickoffAt?Date.parse(game.kickoffAt):NaN;
 if(!Number.isFinite(kickoff)||kickoff>now||game.homeScore===null||game.awayScore===null)return null;
 if(game.auditVersion===GAME_AUDIT_VERSION)return null;
 if(game.jobs.some(job=>job.status==='running'&&['analyze','refresh-audit'].includes(job.kind)))return null;
 if(game.jobs.some(job=>job.status==='pending'&&(job.kind==='refresh-audit'||job.key?.startsWith('catchup:'))))return null;
 return game.revisionId?'refresh-audit':'analyze';
}

export async function queueSeasonCatchup(season:number,weeks:number[]){
 const games=await getSeasonCoverage(season,weeks);
 const queued=[];
 for(const game of games){
  const kind=catchupKind(game);if(!kind)continue;
  // An explicit catch-up precedes old FIFO work; normal new-game priority still wins.
  const failures=game.jobs.filter(job=>job.kind===kind&&job.status==='failed').length;
  const key=`catchup:${GAME_AUDIT_VERSION}:${game.id}:${game.revisionId??'initial'}:${failures}`;
  const id=await enqueue(kind,game.id,{backfill:true,preferRaw:false,prepareDraft:true},key,new Date('2000-01-01T00:00:00Z'));
  queued.push({gameId:game.id,kind,jobId:id});
 }
 return {season,weeks:validateCoverageScope(season,weeks),scheduledGames:games.length,queued,games};
}
