import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { config } from '../packages/core/src/config.js';
import type { AnalysisResult,Game,SourceSnapshot } from '../packages/core/src/contracts.js';

const namespace=`ur_maturity_${randomUUID().replaceAll('-','')}`;
const originalDatabaseUrl=config.databaseUrl;
let admin:pg.Client;
let db:typeof import('../packages/core/src/db.js');
let repository:typeof import('../packages/core/src/repository.js');
let reviews:typeof import('../packages/core/src/reviews.js');
const game:Game={id:'2099_01_TST_DEMO',season:2099,week:1,gameType:'REG',homeTeam:'DEMO',awayTeam:'TST',homeScore:0,awayScore:0,kickoffAt:'2099-09-10T17:00:00.000Z',providerData:{result:0,synthetic:true}};
const plays=[1,2,3,4,4].map((qtr,index)=>({game_id:game.id,season:game.season,home_team:game.homeTeam,away_team:game.awayTeam,play_id:index+1,qtr,desc:index===0?'GAME':index===4?'END GAME':'Synthetic play',total_home_score:0,total_away_score:0}));
const clean:SourceSnapshot={id:'synthetic-clean',provider:'nflverse-pbp',url:'https://example.invalid/clean',checksum:'a'.repeat(64),retrievedAt:'2099-09-11T00:00:00.000Z',path:'/synthetic/clean',license:'Synthetic test data',metadata:{synthetic:true}};
const raw:SourceSnapshot={...clean,id:'synthetic-raw',provider:'nflverse-raw-pbp',url:'https://example.invalid/raw',checksum:'b'.repeat(64)};
const result=(value=0.02):AnalysisResult=>({schemaVersion:1,metrics:[{id:'synthetic',category:'coaching',name:'Synthetic cost',team:'TST',value,unit:'wp_delta',status:'supported',eventIds:[`${game.id}:2`],playIds:['2'],assumptions:['Synthetic only'],modelVersion:'test',coverage:{eligible:1,modeled:1}}],events:[{id:`${game.id}:2`,playId:'2',quarter:2,clock:'02:00',description:'Synthetic play',kind:'coaching',team:'TST',reviewStatus:'not_reviewed'}],timeline:[],coverage:[],models:[],warnings:['Synthetic only']});

// Deliberately reconstruct the pre-fix bug without weakening the new save guard.
async function legacyRaw(previousId:string,analysis=result()){
 await repository.saveSnapshots([raw]);
 const id=randomUUID();
 await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json,source_kind)
 SELECT $1,game_id,number+1,$2,'preliminary',charting_status,'Legacy regression fixture',summary,$3,$4,game_json,'raw' FROM analysis_revisions WHERE id=$5`,[id,randomUUID(),JSON.stringify(analysis),JSON.stringify([raw.id]),previousId]);
 return id;
}

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('source maturity and legacy repair (isolated PostgreSQL schema)',()=>{
 beforeAll(async()=>{
  admin=new pg.Client({connectionString:originalDatabaseUrl,connectionTimeoutMillis:5000});await admin.connect();
  if(!/^ur_maturity_[a-f0-9]{32}$/.test(namespace))throw new Error('Unsafe test schema');
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const connection=new URL(originalDatabaseUrl);connection.searchParams.set('options',`-c search_path=${namespace}`);config.databaseUrl=connection.toString();
  db=await import('../packages/core/src/db.js');await db.migrate();repository=await import('../packages/core/src/repository.js');reviews=await import('../packages/core/src/reviews.js');
 },60000);
 beforeEach(async()=>{await db.query('TRUNCATE games,source_snapshots,users CASCADE');});
 afterAll(async()=>{
  await db?.pool.end();
  if(admin){if(!/^ur_maturity_[a-f0-9]{32}$/.test(namespace))throw new Error('Unsafe test cleanup');await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await admin.end();}
  config.databaseUrl=originalDatabaseUrl;
 });
 it('blocks clean to raw regression under the revision lock without changing current evidence',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  await expect(repository.saveAnalysis(game,plays,[raw],result(0.08),'raw')).rejects.toMatchObject({code:'source_downgrade'});
  expect((await repository.getReport(game.id))?.revision.id).toBe(first.id);
  expect((await db.query('SELECT 1 FROM source_snapshots WHERE id=$1',[raw.id])).rowCount).toBe(0);
 });
 it('backfills maturity from original sources even when the statistical label says corrected',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');const rawId=await legacyRaw(first.id);
  await db.query("UPDATE analysis_revisions SET statistical_status='corrected'");
  // Re-run the new migration over legacy-shaped rows inside this generated schema.
  await db.query('ALTER TABLE analysis_revisions DROP COLUMN source_kind');
  await db.query("DELETE FROM schema_migrations WHERE name='004_revision_source_kind.sql'");
  await db.migrate();
  expect((await db.query('SELECT id,source_kind FROM analysis_revisions ORDER BY number')).rows).toEqual([{id:first.id,source_kind:'clean'},{id:rawId,source_kind:'raw'}]);
 });
 it('fixes the observed clean to legacy raw to identical clean sequence and remains idempotent',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  const rawId=await legacyRaw(first.id);
  const restored=await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  expect(restored).toMatchObject({number:3,created:true});
  const report=await repository.getReport(game.id);
  expect(report?.revision.id).toBe(restored.id);expect(report?.revision.statisticalStatus).toBe('reconciled');
  expect(report?.revision.sourceSnapshots.map(s=>s.provider)).toEqual(['nflverse-pbp']);
  expect(report?.revision.changeSummary).toContain('Restored verified clean-source evidence');
  expect((await repository.getReport(game.id,2))?.revision.id).toBe(rawId);
  expect((await repository.getReport(game.id,2))?.revision.statisticalStatus).toBe('preliminary');
  expect(await repository.saveAnalysis(game,plays,[clean],result(),'clean')).toEqual({...restored,created:false});
  expect((await repository.getReport(game.id))?.history).toHaveLength(3);
 });
 it('never restores an old duplicate over a genuine later clean correction',async()=>{
  await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  const corrected=await repository.saveAnalysis(game,plays,[clean],result(0.09),'clean');
  expect(await repository.saveAnalysis(game,plays,[clean],result(),'clean')).toEqual({...corrected,created:false});
  expect((await repository.getReport(game.id))?.revision.analysis.metrics[0].value).toBe(0.09);
 });
 it('repairs equivalent persisted raw-latest evidence without R or changing original revisions',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');await legacyRaw(first.id);
  expect(await repository.repairSourceRegressions(2099)).toEqual([{gameId:game.id,revisionId:expect.any(String),status:'restored'}]);
  expect((await repository.getReport(game.id))?.revision.number).toBe(3);
  expect((await repository.getReport(game.id,1))?.revision.analysis).toEqual(result());
  expect(await repository.repairSourceRegressions(2099)).toEqual([]);
 });
 it('preserves a genuine later raw numerical change for fresh clean reconciliation',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');const rawId=await legacyRaw(first.id,result(0.09));
  expect(await repository.repairSourceRegressions(2099)).toEqual([{gameId:game.id,revisionId:rawId,status:'reconcile',reason:expect.stringContaining('findings changed')}]);
  expect((await repository.getReport(game.id))?.revision.id).toBe(rawId);
 });
 it('refuses repair when stored clean finality or order cannot be verified',async()=>{
  const first=await repository.saveAnalysis(game,plays.slice(0,-1),[clean],result(),'clean');const rawId=await legacyRaw(first.id);
  expect((await repository.repairSourceRegressions(2099))[0]).toMatchObject({status:'reconcile',reason:expect.stringContaining('complete final game')});
  expect((await repository.getReport(game.id))?.revision.id).toBe(rawId);
 });
 it('copies maturity into review revisions and preserves stale approvals during repair',async()=>{
  const first=await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  const userId=randomUUID();await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic','unused','admin')",[userId]);
  const session={id:'test',userId,username:'synthetic',role:'admin' as const,csrfToken:'test',expiresAt:'2099-12-31T00:00:00.000Z'};
  const reviewId=await reviews.saveReview({gameId:game.id,eventId:`${game.id}:2`,status:'supported',ruleSeason:2099,ruleReference:'Synthetic rule',evidenceUrl:'https://example.invalid/evidence',rationale:'Synthetic scoped assessment.',confidence:'medium',scope:'One synthetic play only.',scopeComplete:true,replayCorrected:false},session);
  await reviews.approveReview(reviewId,session);
  const reviewed=await repository.getReport(game.id);
  expect((await db.query('SELECT source_kind FROM analysis_revisions WHERE id=$1',[reviewed!.revision.id])).rows[0].source_kind).toBe('clean');
  // An ordinary source retry cannot return an older unreviewed revision.
  expect(await repository.saveAnalysis(game,plays,[clean],result(),'clean')).toEqual({id:reviewed!.revision.id,number:reviewed!.revision.number,created:false});
  await expect(repository.saveAnalysis(game,plays,[raw],result(),'raw')).rejects.toMatchObject({code:'source_downgrade'});
  await legacyRaw(reviewed!.revision.id,reviewed!.revision.analysis);
  await db.query('UPDATE reviews SET stale=true WHERE id=$1',[reviewId]);
  expect((await repository.repairSourceRegressions(2099))[0].status).toBe('restored');
  const after=await repository.getReport(game.id);
  expect(after?.reviews.find(r=>r.id===reviewId)?.stale).toBe(true);
  expect(after?.revision.reviewStatus).toBe('not_reviewed');
  expect((await repository.getReport(game.id,reviewed!.revision.number))?.revision.reviewStatus).toBe('reviewed_within_scope');
  expect((await repository.getReport(game.id,1))?.revision.id).toBe(first.id);
 });
 it('marks affected reviews stale on a real clean correction while preserving their original approved revision',async()=>{
  await repository.saveAnalysis(game,plays,[clean],result(),'clean');
  const userId=randomUUID();await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic','unused','admin')",[userId]);
  const session={id:'test',userId,username:'synthetic',role:'admin' as const,csrfToken:'test',expiresAt:'2099-12-31T00:00:00.000Z'};
  const reviewId=await reviews.saveReview({gameId:game.id,eventId:`${game.id}:2`,status:'supported',ruleSeason:2099,ruleReference:'Synthetic rule',evidenceUrl:'https://example.invalid/evidence',rationale:'Synthetic scoped assessment.',confidence:'medium',scope:'One synthetic play only.',scopeComplete:true,replayCorrected:false},session);
  await reviews.approveReview(reviewId,session);
  const approved=await repository.getReport(game.id);
  const corrected=await repository.saveAnalysis(game,plays,[clean],result(0.09),'clean');
  const current=await repository.getReport(game.id);
  expect(current?.revision.id).toBe(corrected.id);
  expect(current?.revision.statisticalStatus).toBe('corrected');
  expect(current?.revision.reviewStatus).toBe('not_reviewed');
  expect(current?.reviews.find(review=>review.id===reviewId)?.stale).toBe(true);
  expect((await repository.getReport(game.id,approved!.revision.number))?.reviews.find(review=>review.id===reviewId)).toMatchObject({approved:true,stale:false});
 });
});
