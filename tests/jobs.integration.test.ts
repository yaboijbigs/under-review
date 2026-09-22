import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../packages/core/src/config.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const namespace = `ur_jobs_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = config.databaseUrl;
let admin: pg.Client;
let db: typeof import('../packages/core/src/db.js');
let jobs: typeof import('../packages/core/src/jobs.js');
let coverage:typeof import('../packages/core/src/season-coverage.js');
const due = (hours: number) => new Date(Date.now() - hours * 3600000);

async function game(id: string, hoursAgo: number, analyzed = false) {
  await db.query("INSERT INTO games(id,season,week,game_type,home_team,away_team,kickoff_at,game_json) VALUES($1,2026,2,'REG','HOME','AWAY',$2,'{}')", [id, due(hoursAgo)]);
  if (analyzed) await db.query("INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids) VALUES($1,$2,1,'synthetic','reconciled','unavailable','test','test','{}','[]')", [randomUUID(), id]);
}
async function claimAndFinish(worker = 'scheduler-test') {
  const job = await jobs.claimJob(worker);
  if (job) await jobs.finishJob(job);
  return job;
}

describe.skipIf(!enabled)('scheduler priority and coalescing (isolated PostgreSQL schema)', () => {
  beforeAll(async () => {
    if (!/^ur_jobs_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test schema');
    admin = new pg.Client({ connectionString: originalDatabaseUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const connection = new URL(originalDatabaseUrl);
    connection.searchParams.set('options', `-c search_path=${namespace}`);
    config.databaseUrl = connection.toString();
    db = await import('../packages/core/src/db.js');
    await db.migrate();
    jobs = await import('../packages/core/src/jobs.js');
    coverage = await import('../packages/core/src/season-coverage.js');
  }, 60000);
  beforeEach(async () => { await db.query('TRUNCATE jobs, games CASCADE'); });
  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      if (!/^ur_jobs_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test cleanup');
      await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
    config.databaseUrl = originalDatabaseUrl;
  });

  it('claims schedule sync before an older historical backlog, then the missing recent report', async () => {
    await game('historical', 200);
    await game('recent-missing', 4);
    const old = await jobs.enqueue('analyze', 'historical', { backfill: true }, 'old', due(72));
    const recent = await jobs.enqueue('analyze', 'recent-missing', {}, 'recent', due(1));
    const sync = await jobs.enqueue('sync-season', null, { season: 2026 }, 'sync', due(0));
    expect((await claimAndFinish())?.id).toBe(sync);
    expect((await claimAndFinish())?.id).toBe(recent);
    expect((await claimAndFinish())?.id).toBe(old);
  });

  it('prioritizes a missing recent report above old reconciliation and audit-refresh work', async () => {
    await game('already-analyzed', 3, true);
    await game('missing', 35);
    const refresh = await jobs.enqueue('refresh-audit', 'already-analyzed', {}, 'refresh', due(72));
    const reconcile = await jobs.enqueue('analyze', 'already-analyzed', { preferRaw: false }, 'reconcile', due(48));
    const initial = await jobs.enqueue('analyze', 'missing', {}, 'initial', due(0));
    expect((await claimAndFinish())?.id).toBe(initial);
    expect((await claimAndFinish())?.id).toBe(refresh);
    expect((await claimAndFinish())?.id).toBe(reconcile);
  });

  it('does not prioritize kickoff outside the last 36 hours or bypass future run-after times', async () => {
    await game('outside-window', 37);
    await game('future-kickoff', -1);
    await game('recent', 1);
    const first = await jobs.enqueue('refresh-audit', 'other', {}, 'first', due(72));
    const second = await jobs.enqueue('analyze', 'outside-window', {}, 'outside', due(48));
    const third = await jobs.enqueue('analyze', 'future-kickoff', {}, 'future-game', due(1));
    await jobs.enqueue('analyze', 'recent', {}, 'not-due', due(-6));
    await jobs.enqueue('sync-season', null, {}, 'future-sync', due(-1));
    expect((await claimAndFinish())?.id).toBe(first);
    expect((await claimAndFinish())?.id).toBe(second);
    expect((await claimAndFinish())?.id).toBe(third);
    expect(await jobs.claimJob('nothing-due')).toBeNull();
  });

  it('coalesces concurrent schedule buckets without changing the existing payload or due time', async () => {
    const originalDue = due(1);
    const first = await jobs.enqueueAnalysisIfIdle('one-game', { preferRaw: false, backfill: true }, 'bucket:first', originalDue);
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, n) => jobs.enqueueAnalysisIfIdle('one-game', { preferRaw: true }, `bucket:${n}`)));
    expect(new Set([first, ...concurrent]).size).toBe(1);
    const rows = (await db.query('SELECT payload,run_after,status FROM jobs')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ payload: { preferRaw: false, backfill: true }, run_after: originalDue, status: 'pending' });
    const running = await jobs.claimJob('active-worker');
    expect(await jobs.enqueueAnalysisIfIdle('one-game', {}, 'while-running')).toBe(first);
    await jobs.finishJob(running!);
    expect(await jobs.enqueueAnalysisIfIdle('one-game', {}, 'after-success')).not.toBe(first);
  });

  it('creates only one pending analysis when schedulers race on an empty game queue', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, (_, n) => jobs.enqueueAnalysisIfIdle('empty-game', { preferRaw: false }, `racing-bucket:${n}`)));
    expect(new Set(ids).size).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE game_id='empty-game' AND status='pending'")).rows[0].count).toBe(1);
  });

  it('coalesces due-now jobs when callers acquire the lock in the opposite timestamp order', async () => {
    const olderCallerTime = new Date(Date.now() - 1000);
    const winner = await jobs.enqueueAnalysisIfIdle('out-of-order', { preferRaw: true }, 'newer-caller', new Date());
    // Deterministically models an older caller waiting while a newer caller wins
    // the advisory lock, instead of relying on thread scheduling for the race.
    const lateAcquirer = await jobs.enqueueAnalysisIfIdle('out-of-order', { preferRaw: false }, 'older-caller', olderCallerTime);
    expect(lateAcquirer).toBe(winner);
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE game_id='out-of-order' AND status='pending'")).rows[0].count).toBe(1);
    expect((await claimAndFinish())?.payload.preferRaw).toBe(false);
  });

  it('uses one per-game exclusion across refresh and analysis claims', async () => {
    await jobs.enqueue('refresh-audit', 'same-game', {}, 'refresh');
    await jobs.enqueue('analyze', 'same-game', {}, 'analysis');
    const attempts = await Promise.all([jobs.claimJob('one'), jobs.claimJob('two')]);
    const claimed = attempts.filter(job => job !== null);
    expect(claimed).toHaveLength(1);
    expect(await jobs.claimJob('blocked')).toBeNull();
    await jobs.finishJob(claimed[0]!);
    const next = await jobs.claimJob('next');
    expect(next?.gameId).toBe('same-game');
    expect(next?.kind).not.toBe(claimed[0]?.kind);
    await jobs.finishJob(next!);
  });

  it('preserves the explicit 6/24/48-hour reconciliation jobs without claiming them early', async () => {
    const start = Date.now();
    const ids = [];
    for (const hours of [6, 24, 48]) ids.push(await jobs.enqueue('analyze', 'reconciled-game', { preferRaw: false, backfill: false }, `reconcile:initial:${hours}`, new Date(start + hours * 3600000)));
    const immediate = await jobs.enqueueAnalysisIfIdle('reconciled-game', { preferRaw: false }, 'scheduler-extra');
    expect(ids).not.toContain(immediate);
    expect((await claimAndFinish())?.id).toBe(immediate);
    expect((await db.query("SELECT run_after FROM jobs WHERE status='pending' ORDER BY run_after")).rows.map(row => row.run_after.getTime() - start)).toEqual([6, 24, 48].map(hours => hours * 3600000));
    expect(await jobs.claimJob('early')).toBeNull();
    await db.query('UPDATE jobs SET run_after=$2 WHERE id=$1', [ids[0], due(1)]);
    expect((await claimAndFinish())?.id).toBe(ids[0]);
    expect(await jobs.claimJob('still-early')).toBeNull();
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE status='pending'")).rows[0].count).toBe(2);
  });

  it('upgrades queued raw work when clean reconciliation is coalesced, without changing due time or backfill', async () => {
    const when = due(1);
    const id = await jobs.enqueueAnalysisIfIdle('raw-queued', { preferRaw: true, backfill: true }, 'raw', when);
    expect(await jobs.enqueueAnalysisIfIdle('raw-queued', { preferRaw: false }, 'clean')).toBe(id);
    expect((await db.query('SELECT payload,run_after FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ payload: { preferRaw: false, backfill: true }, run_after: when });
    expect(await jobs.enqueueAnalysisIfIdle('raw-queued', { preferRaw: true }, 'raw-again')).toBe(id);
    expect((await claimAndFinish())?.payload.preferRaw).toBe(false);
  });

  it('retains refresh failures and normal retries rather than marking them successful', async () => {
    const id = await jobs.enqueue('refresh-audit', 'failure-game', {}, 'failure');
    const first = await jobs.claimJob('first');
    await jobs.finishJob(first!, new Error('Synthetic source unavailable'));
    expect((await db.query('SELECT status,attempts,error FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ status: 'pending', attempts: 1, error: 'Synthetic source unavailable' });
    expect(await jobs.claimJob('too-soon')).toBeNull();
    await db.query('UPDATE jobs SET run_after=$2,max_attempts=2 WHERE id=$1', [id, due(1)]);
    const second = await jobs.claimJob('second');
    await jobs.finishJob(second!, new Error('Synthetic source still unavailable'));
    expect((await db.query('SELECT status,attempts FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ status: 'failed', attempts: 2 });
  });

  it('queues catch-up after an exhausted abandoned job without changing active leases',async()=>{
    await game('older-completed-game',240,true);
    await db.query("UPDATE games SET game_json='{\"homeScore\":20,\"awayScore\":17}'::jsonb WHERE id='older-completed-game'");
    const expired=await jobs.enqueue('analyze','older-completed-game',{},'exhausted-before-restart');
    const active=await jobs.enqueue('analyze','active-game',{},'active-lease');
    const retry=await jobs.enqueue('analyze','retry-game',{},'retry-lease');
    await db.query("UPDATE jobs SET status='running',attempts=max_attempts,worker_id='old-worker',lease_until=now()-interval '1 minute' WHERE id=$1",[expired]);
    await db.query("UPDATE jobs SET status='running',attempts=1,worker_id='live-worker',lease_until=now()+interval '1 minute' WHERE id=$1",[active]);
    await db.query("UPDATE jobs SET status='running',attempts=1,worker_id='old-worker',lease_until=now()-interval '1 minute' WHERE id=$1",[retry]);
    expect((await coverage.queueSeasonCatchup(2026,[2])).queued).toEqual([]);
    const activeBefore=(await db.query('SELECT * FROM jobs WHERE id=$1',[active])).rows[0];
    await jobs.recoverExpiredJobs();
    expect((await db.query('SELECT status,worker_id,lease_until FROM jobs WHERE id=$1',[expired])).rows[0]).toEqual({status:'failed',worker_id:null,lease_until:null});
    expect((await db.query('SELECT status FROM jobs WHERE id=$1',[retry])).rows[0].status).toBe('pending');
    expect((await db.query('SELECT * FROM jobs WHERE id=$1',[active])).rows[0]).toEqual(activeBefore);
    const catchup=await coverage.queueSeasonCatchup(2026,[2]);
    expect(catchup.queued).toEqual([{gameId:'older-completed-game',kind:'refresh-audit',jobId:expect.any(String)}]);
    expect((await coverage.queueSeasonCatchup(2026,[2])).queued).toEqual([]);
    expect((await claimAndFinish())?.id).toBe(catchup.queued[0].jobId);
  });
});
