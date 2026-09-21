import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../packages/core/src/config.js';
import type { AnalysisResult, Game, SourceSnapshot } from '../packages/core/src/contracts.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const namespace = `ur_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let db: typeof import('../packages/core/src/db.js');
let repository: typeof import('../packages/core/src/repository.js');
let jobs: typeof import('../packages/core/src/jobs.js');
let publishing: typeof import('../packages/core/src/publishing.js');
let reviews: typeof import('../packages/core/src/reviews.js');
const originalDatabaseUrl = config.databaseUrl;

const game: Game = {
  id: '2099_01_TST_DEMO', season: 2099, week: 1, gameType: 'REG', homeTeam: 'DEMO', awayTeam: 'TST',
  homeScore: 17, awayScore: 10, kickoffAt: '2099-09-10T17:00:00.000Z',
  providerData: { synthetic: true, result: 7 },
};
const snapshot: SourceSnapshot = {
  id: 'synthetic-database-fixture-v1', provider: 'synthetic-pbp', url: 'https://example.invalid/synthetic-pbp',
  retrievedAt: '2099-09-10T21:00:00.000Z', checksum: 'a'.repeat(64), path: '/synthetic/test-only',
  license: 'Synthetic test data', metadata: { synthetic: true },
};
function result(value = 0.02): AnalysisResult {
  return {
    schemaVersion: 1,
    metrics: [{ id: 'synthetic-decision', category: 'coaching', name: 'Synthetic decision cost', team: 'TST', value, unit: 'wp_delta', status: 'supported', eventIds: [`${game.id}:50`], playIds: ['50'], assumptions: ['Explicitly synthetic database test.'], modelVersion: 'synthetic-v1', coverage: { eligible: 1, modeled: 1 } }],
    events: [{ id: `${game.id}:50`, playId: '50', quarter: 4, clock: '02:00', description: 'Synthetic test decision.', kind: 'coaching', team: 'TST', reviewStatus: 'not_reviewed' }],
    timeline: [], coverage: [{ category: 'execution', status: 'unavailable', eligible: 0, modeled: 0, reason: 'Synthetic test has no charting.' }],
    models: [], warnings: ['Explicitly synthetic fixture; never publish.'],
  };
}

describe.skipIf(!enabled)('PostgreSQL durable revisions and jobs (isolated temporary schema)', () => {
  beforeAll(async () => {
    if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid generated test schema.');
    admin = new pg.Client({ connectionString: originalDatabaseUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const connection = new URL(originalDatabaseUrl);
    connection.searchParams.set('options', `-c search_path=${namespace}`);
    config.databaseUrl = connection.toString();
    db = await import('../packages/core/src/db.js');
    await db.migrate();
    repository = await import('../packages/core/src/repository.js');
    jobs = await import('../packages/core/src/jobs.js');
    publishing = await import('../packages/core/src/publishing.js');
    reviews = await import('../packages/core/src/reviews.js');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      // This namespace is generated above and never includes production tables or fixture records.
      if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Refusing unsafe test cleanup.');
      await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
    config.databaseUrl = originalDatabaseUrl;
  }, 30_000);

  it('reprocesses identical evidence without duplicate revisions or dry-run drafts', async () => {
    const first = await repository.saveAnalysis(game, [{ play_id: 50 }], [snapshot], result(), 'clean');
    const repeated = await repository.saveAnalysis(game, [{ play_id: 50 }], [snapshot], result(), 'clean');
    expect(first.created).toBe(true);
    expect(repeated).toEqual({ id: first.id, number: 1, created: false });
    const one = await publishing.createDraft(game.id);
    const two = await publishing.createDraft(game.id);
    expect(two.id).toBe(one.id);
    expect((await db.query('SELECT count(*)::integer AS n FROM publication_outbox')).rows[0].n).toBe(1);
    expect((await db.query('SELECT mode,status FROM publication_outbox')).rows[0]).toEqual({ mode: 'dry_run', status: 'draft' });
  });

  it('preserves the old score and findings when a correction creates a new revision', async () => {
    const corrected: Game = { ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } };
    const changed = await repository.saveAnalysis(corrected, [{ play_id: 50 }], [{ ...snapshot, id: 'synthetic-database-fixture-v2', checksum: 'b'.repeat(64) }], result(0.03), 'clean');
    expect(changed.number).toBe(2);
    const previous = await repository.getReport(game.id, 1);
    const latest = await repository.getReport(game.id);
    expect(previous?.game.homeScore).toBe(17);
    expect(previous?.revision.analysis.metrics[0].value).toBe(0.02);
    expect(latest?.game.homeScore).toBe(20);
    expect(latest?.revision.analysis.metrics[0].value).toBe(0.03);
    expect(latest?.revision.statisticalStatus).toBe('corrected');
    expect(latest?.history).toHaveLength(2);
  });

  it('allows only one of two workers to claim jobs for the same game', async () => {
    await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:first');
    await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:second');
    const claims = await Promise.all([jobs.claimJob('synthetic-worker-one'), jobs.claimJob('synthetic-worker-two')]);
    const claimed = claims.filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect((await db.query("SELECT count(*)::integer AS n FROM jobs WHERE status='running'")).rows[0].n).toBe(1);
    await jobs.finishJob(claimed[0]!);
    const next = await jobs.claimJob('synthetic-worker-three');
    expect(next).not.toBeNull();
    expect(next?.id).not.toBe(claimed[0]?.id);
    await jobs.finishJob(next!);
  });

  it('recovers an expired job lease without permitting the stale worker to finish the new claim', async () => {
    const id = await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:lease');
    const abandoned = await jobs.claimJob('synthetic-abandoned');
    expect(abandoned?.id).toBe(id);
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 minute' WHERE id=$1", [id]);
    const recovered = await jobs.claimJob('synthetic-recovery');
    expect(recovered?.id).toBe(id);
    expect(recovered?.attempts).toBe(2);
    await jobs.finishJob(abandoned!);
    expect((await db.query('SELECT status,worker_id FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ status: 'running', worker_id: 'synthetic-recovery' });
    await jobs.finishJob(recovered!);
  });

  it('keeps live submission disabled by default, without contacting X', async () => {
    expect(await publishing.getPublishingSettings()).toEqual({ mode: 'draft-only', killSwitch: true, accountId: null, activatedAt: null });
    await expect(publishing.publishOutbox(randomUUID())).rejects.toThrow('Live publishing blocked');
    expect((await db.query('SELECT count(*)::integer AS n FROM publication_attempts')).rows[0].n).toBe(0);
  });

  it('preserves scoped reviews on unchanged evidence across a new source snapshot', async () => {
    const reviewerId = randomUUID();
    await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic-reviewer','unused-test-password-hash','admin')", [reviewerId]);
    const session = { id: 'synthetic-session', userId: reviewerId, username: 'synthetic-reviewer', role: 'admin' as const, csrfToken: 'synthetic-csrf', expiresAt: '2099-12-31T00:00:00.000Z' };
    const reviewId = await reviews.saveReview({
      gameId: game.id, eventId: `${game.id}:50`, status: 'supported', ruleSeason: 2099,
      ruleReference: 'Synthetic rule reference', evidenceUrl: 'https://example.invalid/synthetic-evidence',
      rationale: 'Explicitly synthetic review to test revision preservation.', confidence: 'medium',
      scope: 'One synthetic test play; not a comprehensive review.', replayCorrected: false,
    }, session);
    await reviews.approveReview(reviewId, session);
    const before = await repository.getReport(game.id);
    expect(before?.reviews.find((review) => review.id === reviewId)?.stale).toBe(false);
    await repository.saveAnalysis({ ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } }, [{ play_id: 50 }], [{ ...snapshot, id: 'synthetic-database-fixture-v3', checksum: 'c'.repeat(64) }], result(0.03), 'clean');
    const after = await repository.getReport(game.id);
    expect(after?.reviews.find((review) => review.id === reviewId)?.stale).toBe(false);
    expect(after?.revision.analysis.events.find((event) => event.playId === '50')?.reviewStatus).toBe('supported');
  });

  it('deduplicates manual descriptions and retains their underlying event after reconciliation', async () => {
    const reviewer = (await db.query("SELECT id FROM users WHERE username='synthetic-reviewer'")).rows[0];
    const session = { id: 'synthetic-session', userId: reviewer.id, username: 'synthetic-reviewer', role: 'admin' as const, csrfToken: 'synthetic-csrf', expiresAt: '2099-12-31T00:00:00.000Z' };
    const corrected = { ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } };
    const plays = [{ play_id: 50 }, { play_id: 99, qtr: 4, time: '01:00', desc: 'Explicitly synthetic unflagged test play.' }];
    await repository.saveAnalysis(corrected, plays, [{ ...snapshot, id: 'synthetic-database-fixture-v4', checksum: 'd'.repeat(64) }], result(0.03), 'clean');
    const one = await reviews.insertMissedEvent({ gameId: game.id, playId: '99', description: 'First synthetic missed-call description.', team: 'TST' }, session);
    const two = await reviews.insertMissedEvent({ gameId: game.id, playId: '99', description: 'Second description of the same synthetic play.', team: 'TST' }, session);
    expect(two).toBe(one);
    expect((await db.query('SELECT count(*)::integer AS n FROM events WHERE game_id=$1 AND play_id=$2', [game.id, '99'])).rows[0].n).toBe(1);
    await repository.saveAnalysis(corrected, plays, [{ ...snapshot, id: 'synthetic-database-fixture-v5', checksum: 'e'.repeat(64) }], result(0.03), 'clean');
    const after = await repository.getReport(game.id);
    const retained = after?.revision.analysis.events.find((event) => event.id === one);
    expect(retained?.playId).toBe('99');
    expect(retained?.notes).toHaveLength(2);
  });
});
