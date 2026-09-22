import pg from 'pg';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config,projectRoot } from './config.js';

const globalDb=globalThis as typeof globalThis & {urPool?:pg.Pool};
// Keep a warm connection and allow bounded handshake/checkout time on the
// resource-capped host. This changes neither the five-client limit nor retries.
export const databasePoolOptions=Object.freeze({max:5,min:1,connectionTimeoutMillis:15000,idleTimeoutMillis:300000});
export const pool=globalDb.urPool??new pg.Pool({connectionString:config.databaseUrl,...databasePoolOptions});
globalDb.urPool=pool;
export async function query<T extends pg.QueryResultRow=pg.QueryResultRow>(text:string,params:unknown[]=[]):Promise<pg.QueryResult<T>> {return pool.query<T>(text,params);}
export async function transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function migrate(){
 await transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(1926032101)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(path.join(projectRoot,'migrations'))).filter(n=>n.endsWith('.sql')).sort()){
   const sql=await readFile(path.join(projectRoot,'migrations',name),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');
   const existing=await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
   if(existing.rowCount){if(existing.rows[0].checksum!==checksum)throw new Error(`Applied migration changed: ${name}`);continue;}
   await client.query(sql);await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
  }
 });
}
export async function audit(userId:string|null,action:string,target:string|null,details:Record<string,unknown>={}){await query('INSERT INTO audit_log(user_id,action,target,details) VALUES($1,$2,$3,$4)',[userId,action,target,JSON.stringify(details)]);}
