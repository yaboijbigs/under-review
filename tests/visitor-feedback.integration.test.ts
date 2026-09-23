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
const audit:GameAudit={version:'synthetic-test',status:'no_flag_found',headline:'Synthetic test only',profiles:[profile,{...profile,team:'MIN',opponent:'GB',pointsFor:17,pointsAgainst:21,totalYards:300,opponentYards:350,turnoverMargin:-1}],flags:[],reviewCandidates:[],context:[],reference:{version:'test',checksum:'a'.repeat(64),startSeason:1999,endSeason:2025,teamGames:2000},notes:[]};
const submission={revisionId,rulesVersion:SUSPICION_RULES_VERSION,agreement:'agree',rating:1,modelRating:1,comment:'Synthetic private feedback.'};
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
  await Promise.all(Array.from({length:8},()=>feedback.saveVisitorFeedback(gameId,visitor,submission)));
  expect((await db.query('SELECT count(*)::integer AS count FROM visitor_feedback')).rows[0].count).toBe(1);
  await feedback.saveVisitorFeedback(gameId,visitor,{...submission,agreement:'disagree',rating:3,comment:'Changed my view.'});
  expect(await feedback.getVisitorFeedback(gameId,revisionId,SUSPICION_RULES_VERSION,visitor)).toMatchObject({agreement:'disagree',rating:3,comment:'Changed my view.'});
  expect(await feedback.getFeedbackSummary(gameId,revisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:1,agree:0,disagree:1});
 });
 it('separates visitors, report corrections and rules versions',async()=>{
  await feedback.saveVisitorFeedback(gameId,visitor,submission);await feedback.saveVisitorFeedback(gameId,'b'.repeat(64),{...submission,agreement:'disagree',rating:2});await feedback.saveVisitorFeedback(gameId,visitor,{...submission,revisionId:nextRevisionId,rating:4});
  expect(await feedback.getFeedbackSummary(gameId,revisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:2,agree:1,disagree:1});expect(await feedback.getFeedbackSummary(gameId,nextRevisionId,SUSPICION_RULES_VERSION)).toMatchObject({total:1});
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
});
