import { createServer,type Socket } from 'node:net';
import pg from 'pg';
import { describe,expect,it } from 'vitest';
import { config } from '../packages/core/src/config.js';
import { databasePoolOptions } from '../packages/core/src/db.js';

describe('bounded database connection lifecycle',()=>{
  it('terminates one stalled initial handshake without retrying or leaving a checked-out client',async()=>{
    let accepted=0;const sockets=new Set<Socket>();
    // Accept TCP but never answer PostgreSQL startup: this exercises the real
    // pg-pool handshake timer, without contacting or modifying any database.
    const server=createServer(socket=>{accepted++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Temporary listener unavailable');
    const stalled=new pg.Pool({...databasePoolOptions,connectionString:`postgresql://synthetic:synthetic@127.0.0.1:${address.port}/synthetic`});
    try{
      const started=performance.now();
      await expect(stalled.query('SELECT 1')).rejects.toThrow(/connection timeout|timeout expired/);
      const elapsed=performance.now()-started;
      expect(elapsed).toBeGreaterThanOrEqual(14000);expect(elapsed).toBeLessThan(20000);
      expect(accepted).toBe(1);expect(stalled.totalCount).toBe(0);expect(stalled.waitingCount).toBe(0);
    }finally{
      await stalled.end();for(const socket of sockets)socket.destroy();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  },25000);
});

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('warm connection reuse (read-only local PostgreSQL)',()=>{
  it('retires a burst of idle connections while retaining and reusing one authenticated backend',async()=>{
    // Accelerate only the idle clock; use the production warm-client policy and
    // connection cap. No schema or application records are changed.
    const warm=new pg.Pool({...databasePoolOptions,connectionString:config.databaseUrl,idleTimeoutMillis:30});
    try{
      const clients=await Promise.all(Array.from({length:3},()=>warm.connect()));
      const backends=await Promise.all(clients.map(async client=>(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      clients.forEach(client=>client.release());
      await new Promise(resolve=>setTimeout(resolve,100));
      expect(warm.totalCount).toBe(1);expect(warm.idleCount).toBe(1);
      expect(backends).toContain((await warm.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      expect(warm.totalCount).toBe(1);
    }finally{await warm.end();}
  });
});
