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

  it('keeps completion and publication moving for other games while heavy analysis holds its lease', async () => {
    const heavyId = await jobs.enqueue('analyze', 'heavy-game-a', {}, 'heavy-a', due(24));
    const heavy = await jobs.claimJob('heavy-worker', 'analysis');
    expect(heavy?.id).toBe(heavyId);
    const lease = (await db.query('SELECT status,attempts,worker_id,lease_until FROM jobs WHERE id=$1', [heavyId])).rows[0];
    const routineId = await jobs.enqueue('refresh-audit', 'routine-game-d', {}, 'routine-d', due(48));
    const completionId = await jobs.enqueueDataCompletionIfIdle('finished-game-b', 'completion-b');
    const publicationId = await jobs.enqueue('publish', 'rated-game-c', { outboxId: 'synthetic-no-send' }, 'publish-c');
    const claimed = [];
    for (let i = 0; i < 2; i++) {
      const fast = await jobs.claimJob('fast-worker', 'fast');
      expect(fast).not.toBeNull();
      claimed.push(fast!.id);
      await jobs.finishJob(fast!);
    }
    expect(new Set(claimed)).toEqual(new Set([completionId, publicationId]));
    expect(await jobs.claimJob('fast-worker', 'fast')).toBeNull();
    expect((await db.query('SELECT status,attempts,worker_id,lease_until FROM jobs WHERE id=$1', [heavyId])).rows[0]).toEqual(lease);
    expect((await db.query('SELECT status FROM jobs WHERE id=$1', [routineId])).rows[0].status).toBe('pending');
    await jobs.finishJob(heavy!);
    const routine = await jobs.claimJob('heavy-worker', 'analysis');
    expect(routine?.id).toBe(routineId);
    await jobs.finishJob(routine!);
  });

  it('reserves every fast kind for its lane while the analysis lane claims only heavy work', async () => {
    const fastKinds = ['sync-season', 'reconcile-week', 'complete-data', 'complete-referee', 'publish'];
    const fastIds = await Promise.all(fastKinds.map(kind => jobs.enqueue(kind, `${kind}-game`, {}, `lane:${kind}`, due(48))));
    const heavyIds = await Promise.all(['analyze', 'refresh-audit'].map(kind => jobs.enqueue(kind, `${kind}-game`, {}, `lane:${kind}`)));
    const claimedHeavy = [];
    for (let i = 0; i < heavyIds.length; i++) {
      const heavy = await jobs.claimJob('analysis-only', 'analysis');
      expect(heavy).not.toBeNull();
      claimedHeavy.push(heavy!.id);
      await jobs.finishJob(heavy!);
    }
    expect(new Set(claimedHeavy)).toEqual(new Set(heavyIds));
    expect(await jobs.claimJob('analysis-only', 'analysis')).toBeNull();
    const claimedFast = [];
    for (let i = 0; i < fastIds.length; i++) {
      const fast = await jobs.claimJob('fast-only', 'fast');
      expect(fast).not.toBeNull();
      claimedFast.push(fast!.id);
      await jobs.finishJob(fast!);
    }
    expect(new Set(claimedFast)).toEqual(new Set(fastIds));
    expect(await jobs.claimJob('fast-only', 'fast')).toBeNull();
  });

  it.each([
    ['complete-data', 'analysis'], ['complete-data', 'fast'],
    ['complete-referee', 'analysis'], ['complete-referee', 'fast'],
    ['publish', 'analysis'], ['publish', 'fast'],
  ] as const)('excludes concurrent %s and heavy work for one game when %s claims first', async (fastKind, firstLane) => {
    const heavyId = await jobs.enqueue('analyze', 'shared-game', {}, 'shared-heavy');
    const fastId = await jobs.enqueue(fastKind, 'shared-game', {}, 'shared-fast');
    const otherLane = firstLane === 'fast' ? 'analysis' : 'fast';
    const first = await jobs.claimJob('first-owner', firstLane);
    expect(first?.id).toBe(firstLane === 'fast' ? fastId : heavyId);
    expect(await jobs.claimJob('other-owner', otherLane)).toBeNull();
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE game_id='shared-game' AND status='running'")).rows[0].count).toBe(1);
    await jobs.finishJob(first!);
    const second = await jobs.claimJob('other-owner', otherLane);
    expect(second?.id).toBe(firstLane === 'fast' ? heavyId : fastId);
    await jobs.finishJob(second!);
  });

  it('allows only one owner when fast and analysis lanes race on the same game', async () => {
    await jobs.enqueue('analyze', 'racing-lanes', {}, 'racing-heavy');
    await jobs.enqueueDataCompletionIfIdle('racing-lanes', 'racing-completion');
    const claims = await Promise.all([jobs.claimJob('race-heavy', 'analysis'), jobs.claimJob('race-fast', 'fast')]);
    const owners = claims.filter(job => job !== null);
    expect(owners).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE game_id='racing-lanes' AND status='running'")).rows[0].count).toBe(1);
    await jobs.finishJob(owners[0]!);
    const remaining = await jobs.claimJob('after-race', owners[0]!.kind === 'analyze' ? 'fast' : 'analysis');
    expect(remaining).not.toBeNull();
    expect(remaining!.id).not.toBe(owners[0]!.id);
    await jobs.finishJob(remaining!);
  });

  it('coalesces concurrent completion requests while pending or running, then permits a later bucket', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, (_, n) => jobs.enqueueDataCompletionIfIdle('completion-race', `completion-bucket:${n}`)));
    expect(new Set(ids).size).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM jobs WHERE game_id='completion-race' AND kind='complete-data'")).rows[0].count).toBe(1);
    const running = await jobs.claimJob('completion-owner', 'fast');
    expect(running?.id).toBe(ids[0]);
    const before = (await db.query('SELECT * FROM jobs WHERE id=$1', [running!.id])).rows[0];
    const repeated = await Promise.all(Array.from({ length: 4 }, (_, n) => jobs.enqueueDataCompletionIfIdle('completion-race', `while-running:${n}`)));
    expect(new Set(repeated)).toEqual(new Set(ids));
    expect((await db.query('SELECT * FROM jobs WHERE id=$1', [running!.id])).rows[0]).toEqual(before);
    await jobs.finishJob(running!);
    expect(await jobs.enqueueDataCompletionIfIdle('completion-race', before.job_key)).toBe(running!.id);
    const later = await jobs.enqueueDataCompletionIfIdle('completion-race', 'next-completion-bucket');
    expect(later).not.toBe(running!.id);
    const rows = (await db.query("SELECT status FROM jobs WHERE game_id='completion-race' ORDER BY created_at")).rows;
    expect(rows.map(row => row.status).sort()).toEqual(['pending', 'succeeded']);
  });

  it('preserves a future completion retry instead of creating immediate duplicate work', async () => {
    const future = due(-1);
    const id = await jobs.enqueue('complete-data', 'completion-delayed', { synthetic: 'preserve' }, 'future-completion', future);
    const requests = await Promise.all(Array.from({ length: 4 }, (_, n) => jobs.enqueueDataCompletionIfIdle('completion-delayed', `earlier-completion:${n}`)));
    expect(new Set(requests)).toEqual(new Set([id]));
    expect((await db.query('SELECT payload,run_after,status FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ payload: { synthetic: 'preserve' }, run_after: future, status: 'pending' });
    expect(await jobs.claimJob('fast-too-early', 'fast')).toBeNull();
    expect(await jobs.claimJob('all-too-early')).toBeNull();
  });

  it('coalesces referee checks independently of missing aggregates for the same game',async()=>{
    const aggregate=await jobs.enqueueDataCompletionIfIdle('missing-both','aggregate-bucket');
    const refereeIds=await Promise.all(Array.from({length:8},(_,n)=>jobs.enqueueRefereeCompletionIfIdle('missing-both',`referee-bucket:${n}`)));
    expect(new Set(refereeIds).size).toBe(1);
    expect(refereeIds[0]).not.toBe(aggregate);
    const first=await jobs.claimJob('first-completion','fast');
    expect(await jobs.claimJob('blocked-completion','fast')).toBeNull();
    await jobs.finishJob(first!);
    const second=await jobs.claimJob('second-completion','fast');
    expect(new Set([first!.id,second!.id])).toEqual(new Set([aggregate,refereeIds[0]]));
    await jobs.finishJob(second!);
  });

  it('prioritizes data completion over older routine analysis in the default combined lane', async () => {
    await game('routine-completed', 4, true);
    const routine = await jobs.enqueue('analyze', 'routine-completed', { preferRaw: false }, 'routine-old', due(72));
    const refresh = await jobs.enqueue('refresh-audit', 'another-game', {}, 'refresh-old', due(48));
    const completion = await jobs.enqueueDataCompletionIfIdle('newly-finished', 'new-completion');
    expect((await claimAndFinish())?.id).toBe(completion);
    expect((await claimAndFinish())?.id).toBe(routine);
    expect((await claimAndFinish())?.id).toBe(refresh);
  });

  it('can retry exhausted referee fallback analysis on the next completion check',async()=>{
    const failed=await jobs.enqueueAnalysisIfIdle('older-referee-game',{preferRaw:false},'referee-reconcile:older:revision:check-one');
    await db.query("UPDATE jobs SET status='failed',attempts=max_attempts WHERE id=$1",[failed]);
    const next=await jobs.enqueueAnalysisIfIdle('older-referee-game',{preferRaw:false},'referee-reconcile:older:revision:check-two');
    expect(next).not.toBe(failed);
    expect(await jobs.enqueueAnalysisIfIdle('older-referee-game',{preferRaw:false},'referee-reconcile:older:revision:check-three')).toBe(next);
    const claimed=await jobs.claimJob('fallback-owner','analysis');
    expect(claimed?.id).toBe(next);
    await jobs.finishJob(claimed!);
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
