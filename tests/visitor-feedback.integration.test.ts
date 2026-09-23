import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { config } from '../packages/core/src/config.js';
import { SUSPICION_RULES_VERSION } from '../packages/core/src/consumer-summary.js';
import type { GameAudit,GameProfile } from '../packages/core/src/contracts.js';

const namespace=`ur_feedback_${randomUUID().replaceAll('-','')}`,originalDatabaseUrl=config.databaseUrl;
let admin:pg.Client,db:typeof import('../packages/core/src/db.js'),feedback:typeof import('../packages/core/src/visitor-feedback.js'),connected=false;
const gameId='2099_01_GB_MIN',revisionId=randomUUID(),nextRevisionId=randomUUID(),visitor='a'.repeat(64);
const profile:GameProfile={gameId,season:2099,team:'GB',opponent:'MIN',pointsFor:21,pointsAgainst:17,totalYards:350,opponentYards:300,penalties:4,penaltyYards:30,turnoverMargin:1,nonOffensiveTouchdowns:0};
const audit:GameAudit={version:'under-review-game-audit-v4',status:'no_flag_found',headline:'Synthetic test only',profiles:[profile,{...profile,team:'MIN',opponent:'GB',pointsFor:17,pointsAgainst:21,totalYards:300,opponentYards:350,turnoverMargin:-1}],flags:[],reviewCandidates:[],context:[],reference:{version:'test',checksum:'a'.repeat(64),startSeason:1999,endSeason:2025,teamGames:2000},notes:[]};
const submission={revisionId,rulesVersion:'game-suspicion-v2',agreement:'agree',rating:1,modelRating:1,comment:'Synthetic private feedback.'};
describe.skipIf(process.env.RUN_DB_TESTS!=='1')('visitor feedback constraints and concurrent updates (isolated PostgreSQL schema)',()=>{
 beforeAll(async()=>{
  admin=new pg.Client({connectionString:originalDatabaseUrl,connectionTimeoutMillis:5000});await admin.connect();connected=true;if(!/^ur_feedback_[a-f0-9]{32}$/.test(namespace))throw new Error('Invalid test schema');await admin.query(`CREATE SCHEMA ${namespace}`);
  const connection=new URL(originalDatabaseUrl);connection.searchParams.set('options',`-c search_path=${namespace}`);config.databaseUrl=connection.toString();db=await import('../packages/core/src/db.js');await db.migrate();feedback=await import('../packages/core/src/visitor-feedback.js');
 },60000);
 beforeEach(async()=>{
  await db.query('TRUNCATE games CASCADE');
  await db.query("INSERT INTO games(id,season,week,game_type,home_team,away_team,game_json) VALUES($1,2099,1,'REG','MIN','GB','{}')",[gameId]);
  for(const [id,number] of [[revisionId,1],[nextRevisionId,2]])await db.query("INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids) VALUES($1,$2,$3,$4,'reconciled','unavailable','Synthetic test','Synthetic test',$5,'[]')",[id,gameId,number,randomUUID(),JSON.stringify({gameAudit:audit})]);
 });
 afterAll(async()=>{await db?.pool.end();if(connected){if(!/^ur_feedback_[a-f0-9]{32}$/.test(namespace))throw new Error('Invalid cleanup');await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await admin.end();}config.databaseUrl=originalDatabaseUrl;});
 it('keeps concurrent submissions to one vote and permits an explicit update',async()=>{
  await Promise.all(Array.from({length:8},()=>feedback.saveVisitorFeedback(gameId,visitor,{...submission,public:true})));
  expect((await db.query('SELECT count(*)::integer AS count FROM visitor_feedback')).rows[0].count).toBe(1);
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,agreement:'disagree',rating:3,comment:'Changed my view.',public:true});
  expect(await feedback.getVisitorFeedback(gameId,revisionId,SUSPICION_RULES_VERSION,visitor)).toMatchObject({agreement:'disagree',rating:3,comment:'Changed my view.'});
  expect(await feedback.getFeedbackSummary(gameId,revisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:1,agree:0,disagree:1});
 });
 it('counts each browser once across report corrections while preserving revision context',async()=>{
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,public:true});await feedback.saveVisitorFeedback(gameId,'b'.repeat(64),{...submission,agreement:'disagree',rating:2,public:true});await feedback.saveVisitorFeedback(gameId,visitor,{...submission,revisionId:nextRevisionId,rating:4,public:true});
  expect(await feedback.getFeedbackSummary(gameId,revisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:2,agree:1,disagree:1,ratingCount:2,averageRating:3});expect(await feedback.getFeedbackSummary(gameId,nextRevisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:2});
  const publicPage=await feedback.listPublicVisitorFeedback(gameId);expect(publicPage.entries).toHaveLength(2);expect(publicPage.entries.find(entry=>entry.rating===4)?.revisionNumber).toBe(2);expect(await feedback.getPublicFeedbackCounts([gameId])).toEqual({[gameId]:2});
  await expect(feedback.saveVisitorFeedback(gameId,visitor,{...submission,rulesVersion:'old-rules'})).rejects.toMatchObject({status:409});
  expect(await feedback.getVisitorFeedback(gameId,revisionId,SUSPICION_RULES_VERSION,'c'.repeat(64))).toBeNull();
 });
 it('enforces SQL bounds and matching game/revision even if application validation is bypassed',async()=>{
  const insert=(rating:number,comment:string,game=gameId)=>db.query('INSERT INTO visitor_feedback(id,game_id,revision_id,rules_version,visitor_id,agreement,rating,model_rating,comment) VALUES($1,$2,$3,$4,$5,\'agree\',$6,1,$7)',[randomUUID(),game,revisionId,SUSPICION_RULES_VERSION,visitor,rating,comment]);
  await expect(insert(6,'bad rating')).rejects.toMatchObject({code:'23514'});await expect(insert(1,'x'.repeat(1001))).rejects.toMatchObject({code:'23514'});await expect(insert(1,'wrong game','2099_02_GB_MIN')).rejects.toMatchObject({code:'23503'});
  expect((await db.query('SELECT count(*)::integer AS count FROM visitor_feedback')).rows[0].count).toBe(0);
 });
 it('does not alter the analysis when a visitor strongly disagrees',async()=>{
  const before=(await db.query('SELECT analysis FROM analysis_revisions WHERE id=$1',[revisionId])).rows[0].analysis;
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,agreement:'disagree',rating:5,comment:'<script>Untrusted text stays private</script>'});
  expect((await db.query('SELECT analysis FROM analysis_revisions WHERE id=$1',[revisionId])).rows[0].analysis).toEqual(before);
  expect((await feedback.listVisitorFeedback())[0]).toMatchObject({revisionNumber:1,modelRating:1,rating:5,comment:'<script>Untrusted text stays private</script>'});
 });
 it('keeps legacy comments private until explicit public resubmission and permits withdrawal',async()=>{
  // Simulate a legacy writer without any knowledge of the new consent column.
  await db.query("INSERT INTO visitor_feedback(id,game_id,revision_id,rules_version,visitor_id,agreement,rating,model_rating,comment) VALUES($1,$2,$3,$4,$5,'agree',1,1,'Originally private.')",[randomUUID(),gameId,revisionId,submission.rulesVersion,visitor]);
  expect(await feedback.listPublicVisitorFeedback(gameId)).toMatchObject({entries:[],nextCursor:null,summary:{total:0,averageRating:null}});
  await feedback.saveVisitorFeedback(gameId,visitor,submission);expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toHaveLength(0);
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,comment:'Now explicitly public.',public:true});
  expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toEqual([expect.objectContaining({public:true,comment:'Now explicitly public.',revisionId,revisionNumber:1,modelRating:1})]);
  expect(await feedback.getVisitorFeedback(gameId,revisionId,SUSPICION_RULES_VERSION,visitor)).toMatchObject({public:true});
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,public:false});expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toHaveLength(0);
  expect((await db.query('SELECT count(*)::integer AS n FROM visitor_feedback')).rows[0].n).toBe(1);
 });
 it('paginates consented feedback across revisions without skipping tied timestamps or exposing identifiers',async()=>{
  for(const [index,id] of [visitor,'b'.repeat(64),'c'.repeat(64),'d'.repeat(64)].entries())await feedback.saveVisitorFeedback(gameId,id,{...submission,revisionId:index%2===0?revisionId:nextRevisionId,comment:`Public ${index}`,public:true});
  await feedback.saveVisitorFeedback(gameId,'e'.repeat(64),{...submission,comment:'Private do not expose'});
  await feedback.saveVisitorFeedback(gameId,'f'.repeat(64),{...submission,action:'thumb',rating:null,comment:'',public:true});
  await db.query("UPDATE visitor_feedback SET updated_at='2026-09-23T01:02:03.123456Z'");
  const first=await feedback.listPublicVisitorFeedback(gameId,{limit:2}),second=await feedback.listPublicVisitorFeedback(gameId,{limit:2,cursor:first.nextCursor});
  expect(first.entries).toHaveLength(2);expect(second.entries).toHaveLength(2);expect(second.nextCursor).toBeNull();expect(first.summary.total).toBe(5);
  const all=[...first.entries,...second.entries];expect(new Set(all.map(entry=>entry.id)).size).toBe(4);expect(new Set(all.map(entry=>entry.revisionNumber))).toEqual(new Set([1,2]));
  expect(JSON.stringify(all)).not.toContain('Private do not expose');expect(JSON.stringify(all)).not.toContain(visitor);expect(Object.keys(all[0]).sort()).toEqual(['agreement','comment','id','modelRating','public','rating','revisionId','revisionNumber','rulesVersion','updatedAt'].sort());
  expect(await feedback.listPublicVisitorFeedback('2099_02_GB_MIN')).toMatchObject({entries:[],nextCursor:null,summary:{total:0,averageRating:null}});
 });
 it('does not publish a response for missing or unrated analysis',async()=>{
  await expect(feedback.saveVisitorFeedback(gameId,visitor,{...submission,revisionId:randomUUID(),public:true})).rejects.toMatchObject({status:404});
  await db.query("UPDATE analysis_revisions SET analysis='{}' WHERE id=$1",[revisionId]);await expect(feedback.saveVisitorFeedback(gameId,visitor,{...submission,public:true})).rejects.toMatchObject({status:409});
  expect(await feedback.listPublicVisitorFeedback(gameId)).toMatchObject({entries:[],nextCursor:null,summary:{total:0,averageRating:null}});
 });
 it('saves a thumb alone, excludes it from the slider average, and enriches the same response',async()=>{
  const thumb={...submission,action:'thumb',rating:null,comment:'',public:true};
  expect(await feedback.saveVisitorFeedback(gameId,visitor,thumb)).toMatchObject({rating:null,comment:'',public:true});
  expect(await feedback.getFeedbackSummary(gameId)).toMatchObject({total:1,agree:1,ratingCount:0,averageRating:null});
  expect(await feedback.listPublicVisitorFeedback(gameId)).toMatchObject({entries:[],nextCursor:null,summary:{total:1}});
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,rating:null,comment:'A comment without a slider rating.',public:true});
  expect(await feedback.listPublicVisitorFeedback(gameId)).toMatchObject({entries:[{rating:null,comment:'A comment without a slider rating.'}],summary:{total:1,ratingCount:0}});
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,rating:4,comment:'One explanation.',public:true});
  await feedback.saveVisitorFeedback(gameId,visitor,{...thumb,agreement:'disagree',revisionId:nextRevisionId});
  expect(await feedback.getVisitorFeedback(gameId,nextRevisionId,SUSPICION_RULES_VERSION,visitor)).toMatchObject({agreement:'disagree',rating:4,comment:'One explanation.'});
  await feedback.saveVisitorFeedback(gameId,'b'.repeat(64),thumb);
  expect(await feedback.getFeedbackSummary(gameId)).toMatchObject({total:2,agree:1,disagree:1,ratingCount:1,averageRating:4});
  expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toHaveLength(1);
 });
 it('removing the latest comment never resurfaces an earlier explanation',async()=>{
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,comment:'Earlier explanation.',public:true});
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,revisionId:nextRevisionId,comment:'',rating:null,public:true});
  expect(await feedback.listPublicVisitorFeedback(gameId)).toMatchObject({entries:[],nextCursor:null,summary:{total:1,agree:1,ratingCount:0}});
 });
 it('serializes simultaneous thumbs across revisions without multiplying public responses or losing details',async()=>{
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,rating:5,comment:'Keep this explanation.',public:true});
  await Promise.all(Array.from({length:8},(_,index)=>feedback.saveVisitorFeedback(gameId,visitor,{...submission,action:'thumb',revisionId:index%2?nextRevisionId:revisionId,agreement:index%2?'agree':'disagree',rating:null,comment:'',public:true})));
  expect(await feedback.getFeedbackSummary(gameId)).toMatchObject({total:1,ratingCount:1,averageRating:5});expect(await feedback.getPublicFeedbackCounts([gameId])).toEqual({[gameId]:1});
  expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toEqual([expect.objectContaining({rating:5,comment:'Keep this explanation.'})]);
 });
 it('never makes an earlier private explanation public through a thumb click',async()=>{
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,comment:'Private legacy explanation.'});
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,action:'thumb',revisionId:nextRevisionId,public:true});
  const page=await feedback.listPublicVisitorFeedback(gameId);expect(page.entries).toEqual([]);expect(page.summary.total).toBe(1);expect(JSON.stringify(page)).not.toContain('Private legacy explanation.');
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,revisionId:nextRevisionId,public:false});
  expect((await feedback.listPublicVisitorFeedback(gameId)).entries).toHaveLength(0);expect(await feedback.getFeedbackSummary(gameId)).toMatchObject({total:0});
 });
});
