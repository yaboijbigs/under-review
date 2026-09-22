import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { config } from '../packages/core/src/config.js';
import type { Game } from '../packages/core/src/contracts.js';

const namespace=`ur_test_${randomUUID().replaceAll('-','')}`;
const originalDatabaseUrl=config.databaseUrl;
let admin:pg.Client;
let db:typeof import('../packages/core/src/db.js');
let repository:typeof import('../packages/core/src/repository.js');

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('published game listing (isolated temporary schema)',()=>{
 beforeAll(async()=>{
  if(!/^ur_test_[a-f0-9]{32}$/.test(namespace))throw new Error('Invalid generated test schema.');
  admin=new pg.Client({connectionString:originalDatabaseUrl,connectionTimeoutMillis:5000});await admin.connect();
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const connection=new URL(originalDatabaseUrl);connection.searchParams.set('options',`-c search_path=${namespace}`);config.databaseUrl=connection.toString();
  db=await import('../packages/core/src/db.js');await db.migrate();repository=await import('../packages/core/src/repository.js');
 },60000);
 afterAll(async()=>{
  await db?.pool.end();
  if(admin){if(!/^ur_test_[a-f0-9]{32}$/.test(namespace))throw new Error('Refusing unsafe test cleanup.');await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await admin.end();}
  config.databaseUrl=originalDatabaseUrl;
 },30000);
 it('retains a published report behind more than 400 unprocessed scheduled games',async()=>{
  const game:Game={id:'2099_01_TST_DEM',season:2099,week:1,gameType:'REG',homeTeam:'DEM',awayTeam:'TST',homeScore:17,awayScore:10,kickoffAt:'2099-09-10T17:00:00.000Z',providerData:{synthetic:true}};
  await repository.saveAnalysis(game,[],[],{schemaVersion:1,metrics:[],events:[],timeline:[],coverage:[],models:[],warnings:['Synthetic pagination regression; never publish.']},'clean');
  await db.query(`INSERT INTO games(id,season,week,game_type,home_team,away_team,kickoff_at,game_json)
   SELECT 'synthetic-unpublished-'||n,2099,2,'REG','DEM','TST','2099-09-17T17:00:00Z'::timestamptz,
   jsonb_build_object('id','synthetic-unpublished-'||n,'season',2099,'week',2,'gameType','REG','homeTeam','DEM','awayTeam','TST','homeScore',null,'awayScore',null,'kickoffAt','2099-09-17T17:00:00Z','providerData',jsonb_build_object('synthetic',true))
   FROM generate_series(1,401) n`);
  const ordinary=await repository.listGames({season:2099});
  expect(ordinary).toHaveLength(400);expect(ordinary.some(row=>row.id===game.id)).toBe(false);
  const published=await repository.listGames({season:2099,publishedOnly:true});
  expect(published.map(row=>row.id)).toEqual([game.id]);expect(published[0].revisionNumber).toBe(1);
  expect(await repository.listGames({season:2099,week:2,publishedOnly:true})).toEqual([]);
  expect(await repository.listGames({season:2099,team:'OTHER',publishedOnly:true})).toEqual([]);
 });
});
