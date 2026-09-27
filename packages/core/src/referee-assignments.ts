import { createHash } from 'node:crypto';
import { query,transaction } from './db.js';
import type { Game,SourceSnapshot } from './contracts.js';
import { saveSnapshots } from './repository.js';
import { canonicalReferee,loadExpectationsReference } from './expectations.js';
import { refereeAssignmentSchema,type RefereeAssignment } from './referee-assignment-contracts.js';
import { fetchRefereeAssignments } from './referee-assignment-sources.js';
import { enqueue,enqueueRefereeCompletionIfIdle } from './jobs.js';

export const ASSIGNMENT_REFRESH_INTERVAL_MS=15*60*1000;
const providers=['football-zebras','sharp-football'] as const;
export const isAssignmentSnapshot=(source:SourceSnapshot)=>providers.includes(source.provider as typeof providers[number]);
type Feed={provider:typeof providers[number];assignments:{gameId:string;name:string}[];snapshot:SourceSnapshot};
export type CachedRefereeAssignment={assignment?:RefereeAssignment;snapshots:SourceSnapshot[]};

/** Source order is explicit: Football Zebras first, Sharp only as backup/cross-check. */
export function resolveRefereeAssignment(game:Game,feeds:Feed[],canonicalize:(name:string)=>string=(name)=>name.trim().toLowerCase()):CachedRefereeAssignment{
 const selected=providers.flatMap(provider=>{
  const feed=feeds.find(item=>item.provider===provider);
  const rows=feed?.assignments.filter(item=>item.gameId===game.id)??[];
  if(!feed||rows.length!==1)return [];
  const snapshot=feed.snapshot;
  if(snapshot.provider!==provider||snapshot.id!==createHash('sha256').update(`${snapshot.url}\n${snapshot.checksum}`).digest('hex'))return [];
  return [{provider,name:rows[0].name,url:typeof snapshot.metadata?.articleUrl==='string'?snapshot.metadata.articleUrl:snapshot.url,snapshotId:snapshot.id,checksum:snapshot.checksum,snapshot}];
 });
 if(!selected.length)return {snapshots:[]};
 const conflict=new Set(selected.map(source=>canonicalize(source.name))).size>1;
 const parsed=refereeAssignmentSchema.safeParse({gameId:game.id,season:game.season,week:game.week,
  name:conflict?null:selected[0].name,status:conflict?'conflict':'reported',sources:selected.map(({snapshot,...source})=>source)});
 return parsed.success?{assignment:parsed.data,snapshots:selected.map(source=>source.snapshot)}:{snapshots:[]};
}

/** Only reads the local durable cache; analysis never waits for an assignment website. */
export async function getCachedRefereeAssignment(game:Game,saved?:CachedRefereeAssignment):Promise<CachedRefereeAssignment>{
 if(game.gameType!=='REG'||game.week<1||game.week>18)return {snapshots:[]};
 const rows=(await query(`SELECT f.provider,f.assignments,s.snapshot_json AS snapshot FROM referee_assignment_feeds f
  JOIN source_snapshots s ON s.id=f.snapshot_id WHERE f.season=$1 AND f.week=$2`,[game.season,game.week])).rows;
 if(!rows.length){
  // Imported/restored reports can predate this cache. Retain their verified
  // immutable attribution until a source actually supplies replacement facts.
  const prior=refereeAssignmentSchema.safeParse(saved?.assignment);
  if(prior.success&&prior.data.gameId===game.id&&prior.data.season===game.season&&prior.data.week===game.week){
   const snapshots=prior.data.sources.map(source=>saved!.snapshots.find(snapshot=>snapshot.id===source.snapshotId&&snapshot.checksum===source.checksum&&snapshot.provider===source.provider));
   if(snapshots.every((snapshot):snapshot is SourceSnapshot=>!!snapshot))return {assignment:prior.data,snapshots};
  }
  return {snapshots:[]};
 }
 const loaded=await loadExpectationsReference();
 return resolveRefereeAssignment(game,rows as Feed[],name=>(canonicalReferee(name,loaded.reference)??name).toLowerCase());
}

/** Keep the exact first snapshot supporting unchanged facts, avoiding revisions for article/advert edits. */
export async function refreshRefereeAssignments(season:number,week:number){
 const games=(await query("SELECT game_json FROM games WHERE season=$1 AND week=$2 AND game_type='REG' ORDER BY id",[season,week])).rows.map(row=>row.game_json as Game);
 if(!games.length)return {season,week,assignments:0,updatedFeeds:0,warnings:['assignment_schedule_unavailable']};
 const fetched=await fetchRefereeAssignments(season,week,games);
 await saveSnapshots(fetched.snapshots);
 let updatedFeeds=0;
 await transaction(async client=>{
  for(const snapshot of fetched.snapshots){
   const assignments=fetched.assignments.filter(item=>item.provider===snapshot.provider&&item.snapshot.id===snapshot.id)
    .map(({gameId,name})=>({gameId,name})).sort((a,b)=>a.gameId.localeCompare(b.gameId));
   // A failed/empty source must never erase a previously usable weekly feed.
   if(!assignments.length)continue;
   const result=await client.query(`INSERT INTO referee_assignment_feeds(season,week,provider,snapshot_id,assignments)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(season,week,provider) DO UPDATE SET
     snapshot_id=CASE WHEN referee_assignment_feeds.assignments IS DISTINCT FROM excluded.assignments THEN excluded.snapshot_id ELSE referee_assignment_feeds.snapshot_id END,
     assignments=excluded.assignments,checked_at=now()
    RETURNING snapshot_id`,[season,week,snapshot.provider,snapshot.id,JSON.stringify(assignments)]);
   if(result.rows[0].snapshot_id===snapshot.id)updatedFeeds++;
  }
 });
 // Queue metadata-only reconciliation even for an already-known name: a publisher
 // can correct its original assignment. The completion job compares evidence first.
 if(fetched.snapshots.length){
  const rows=(await query(`SELECT g.id FROM games g WHERE g.season=$1 AND g.week=$2
   AND EXISTS(SELECT 1 FROM analysis_revisions r WHERE r.game_id=g.id)`,[season,week])).rows;
  const bucket=Math.floor(Date.now()/ASSIGNMENT_REFRESH_INTERVAL_MS);
  for(const row of rows)await enqueueRefereeCompletionIfIdle(row.id,`assignment-completion:${row.id}:${bucket}`);
 }
 return {season,week,assignments:new Set(fetched.assignments.map(item=>item.gameId)).size,updatedFeeds,warnings:fetched.warnings};
}

/** Prefetch next week's assignments as soon as published; keep unfinished metadata eligible. */
export async function scheduleRefereeAssignmentRefresh(season:number,now=Date.now()):Promise<number>{
 const rows=(await query(`SELECT DISTINCT g.week FROM games g
  LEFT JOIN LATERAL(SELECT analysis FROM analysis_revisions WHERE game_id=g.id ORDER BY number DESC LIMIT 1) r ON true
  WHERE g.season=$1 AND g.game_type='REG' AND g.week BETWEEN 1 AND 18 AND (
   g.kickoff_at BETWEEN $2::timestamptz-interval '8 days' AND $2::timestamptz+interval '7 days'
   OR (g.kickoff_at<=$2::timestamptz AND r.analysis->'gameAudit'->'expectations'->'referee'->>'status' IN ('missing','reported','conflict')))
  ORDER BY g.week`,[season,new Date(now)])).rows;
 for(const row of rows)await enqueue('refresh-referees',null,{season,week:row.week},`referee-assignments:${season}:${row.week}:${Math.floor(now/ASSIGNMENT_REFRESH_INTERVAL_MS)}`);
 return rows.length;
}
