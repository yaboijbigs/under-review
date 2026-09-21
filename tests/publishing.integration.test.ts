import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../packages/core/src/config.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]) }));
const enabled = process.env.RUN_DB_TESTS === '1';
const namespace = `ur_test_${randomUUID().replaceAll('-', '')}`;
const original = { ...config };
const accountId = '123456789', adminId = randomUUID(), reviewerId = randomUUID();
const gameId = '2099_01_TST_DEMO', revisionId = randomUUID();
const reportUrl = `https://under-review.example/games/${gameId}?revision=1`;
const intendedText = `Synthetic test only. Calls not reviewed. ${reportUrl}`;
let admin: pg.Client;
let db: typeof import('../packages/core/src/db.js');
let publishing: typeof import('../packages/core/src/publishing.js');
let requests: { url: string; method: string }[];
let handler: (url: string, init?: RequestInit) => Promise<Response>;

async function makeOutbox(status = 'unknown_outcome') {
  const id = randomUUID();
  await db.query("INSERT INTO publication_outbox(id,game_id,revision_id,account_id,kind,mode,status,text,evidence_ids) VALUES($1,$2,$3,$4,'initial','live',$5,$6,'[]')", [id, gameId, revisionId, accountId, status, intendedText]);
  return id;
}
function postResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({ data: { id: '987654321', author_id: accountId, text: intendedText.replace(reportUrl, 'https://t.co/AbC123'), entities: { urls: [{ url: 'https://t.co/AbC123', expanded_url: reportUrl }] }, ...overrides } });
}

describe.skipIf(!enabled)('publication recovery (isolated PostgreSQL, all HTTP mocked)', () => {
  beforeAll(async () => {
    if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test schema.');
    admin = new pg.Client({ connectionString: original.databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const connection = new URL(original.databaseUrl);
    connection.searchParams.set('options', `-c search_path=${namespace}`);
    Object.assign(config, { databaseUrl: connection.toString(), siteUrl: 'https://under-review.example', tokenEncryptionKey: '1'.repeat(64), staging: false, livePostingAllowed: true });
    db = await import('../packages/core/src/db.js');
    await db.migrate();
    publishing = await import('../packages/core/src/publishing.js');
    await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic-admin','unused','admin'),($2,'synthetic-reviewer','unused','reviewer')", [adminId, reviewerId]);
    await db.query("INSERT INTO games(id,season,week,game_type,home_team,away_team,game_json) VALUES($1,2099,1,'REG','DEMO','TST','{}')", [gameId]);
    await db.query("INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids) VALUES($1,$2,1,'synthetic','reconciled','unavailable','synthetic','synthetic','{}','[]')", [revisionId, gameId]);
  }, 60000);

  beforeEach(async () => {
    requests = [];
    handler = async () => { throw new Error('Unexpected test HTTP call.'); };
    vi.stubEnv('X_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('X_CLIENT_SECRET', 'synthetic-secret');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
      return handler(url, init);
    }));
    await db.query('DELETE FROM publication_attempts');
    await db.query('DELETE FROM publication_outbox');
    await db.query('DELETE FROM jobs');
    await db.query('DELETE FROM audit_log');
    await db.query("INSERT INTO oauth_accounts(id,username,encrypted_tokens,expires_at) VALUES($1,'synthetic-account',$2,now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at", [accountId, publishing.encryptTokens({ access_token: 'synthetic-old', refresh_token: 'synthetic-refresh', expires_in: 3600 })]);
    await db.query("UPDATE settings SET value=$1 WHERE key='publishing'", [JSON.stringify({ mode: 'automatic', killSwitch: false, accountId, activatedAt: '2000-01-01T00:00:00Z' })]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test cleanup.');
      await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
    Object.assign(config, original);
  });

  it('binds only the intended author, complete text and expanded report URL, with durable audit', async () => {
    const id = await makeOutbox();
    handler = async (url) => { expect(url).toBe('https://api.x.com/2/tweets/987654321?tweet.fields=author_id%2Centities'); return postResponse(); };
    await publishing.reconcilePublication(id, 'posted', '987654321', adminId);
    expect((await db.query('SELECT status,external_id FROM publication_outbox WHERE id=$1', [id])).rows[0]).toEqual({ status: 'published', external_id: '987654321' });
    expect((await db.query('SELECT details FROM audit_log')).rows[0].details).toMatchObject({ resolution: 'posted', verified: true, accountId });
    expect(requests.map(request => request.method)).toEqual(['GET']);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it.each(['wrong-author', 'changed-text', 'wrong-url', 'missing-post'])('keeps %s uncertain and never resends', async (failure) => {
    const id = await makeOutbox();
    handler = async () => failure === 'missing-post' ? new Response(null, { status: 404 }) : postResponse(failure === 'wrong-author' ? { author_id: '999' } : failure === 'changed-text' ? { text: 'Different text.' } : { entities: { urls: [{ url: 'https://t.co/AbC123', expanded_url: 'https://attacker.example/' }] } });
    await expect(publishing.reconcilePublication(id, 'posted', '987654321', adminId)).rejects.toThrow();
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('unknown_outcome');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('requires an administrator and permits permanent cancellation without network or resend', async () => {
    const id = await makeOutbox();
    await expect(publishing.reconcilePublication(id, 'cancel', null, reviewerId)).rejects.toThrow('Administrator');
    await expect(publishing.reconcilePublication(id, 'posted', 'https://attacker.example/', adminId)).rejects.toThrow('numeric X post ID');
    await publishing.reconcilePublication(id, 'cancel', null, adminId);
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('may remain unknown') });
    expect(requests).toHaveLength(0);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('keeps an explicit 401 failed when token refresh fails, without treating it as an uncertain post', async () => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/tweets') return new Response(null, { status: 401 });
      if (url === 'https://api.x.com/2/oauth2/token') throw new Error('Synthetic token endpoint outage.');
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('token refresh failed') });
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('refreshes a rejected 401 once and queues a separate attempt atomically', async () => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/oauth2/token') return Response.json({ access_token: 'synthetic-fresh', refresh_token: 'synthetic-rotated', expires_in: 3600 });
      if (url === 'https://api.x.com/2/tweets') return new Response(null, { status: 401 });
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'approved', reason: expect.stringContaining('explicit retry queued') });
    expect((await db.query('SELECT state,http_status FROM publication_attempts')).rows[0]).toEqual({ state: 'retry', http_status: 401 });
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
    const encrypted = (await db.query('SELECT encrypted_tokens FROM oauth_accounts')).rows[0].encrypted_tokens;
    expect(publishing.decryptTokens(encrypted).access_token).toBe('synthetic-fresh');
    expect(requests.filter(request => request.url.endsWith('/2/tweets'))).toHaveLength(1);
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('failed');
    expect(requests.filter(request => request.url.endsWith('/oauth2/token'))).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });

  it.each(['timeout', 'server-error', 'success-without-id'])('preserves unknown outcome after %s without token refresh or retry job', async (failure) => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/tweets') {
        if (failure === 'timeout') throw new Error('Synthetic network interruption.');
        return Response.json({}, { status: failure === 'server-error' ? 503 : 201 });
      }
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('unknown_outcome');
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    expect(requests.filter(request => request.url.endsWith('/oauth2/token'))).toHaveLength(0);
  });
});
