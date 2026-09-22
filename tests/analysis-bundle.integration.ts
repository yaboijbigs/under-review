// Opt-in real-bundle round trip: RUN_DB_TESTS=1 node --import tsx
// tests/analysis-bundle.integration.ts /absolute/path/to/exported-bundle.json
// Run against the local development database with the matching frozen runtime.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { config, safeError } from '../packages/core/src/config.js';
import type { AnalysisBundle } from '../packages/core/src/analysis-bundle.js';

const schema = `ur_bundle_test_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = config.databaseUrl;
const originalDataDir = config.dataDir;
let admin: pg.Client | undefined;
let db: typeof import('../packages/core/src/db.js') | undefined;
let directory: string | undefined;
let schemaCreated = false;

try {
  assert.equal(process.env.RUN_DB_TESTS, '1', 'Real database tests require explicit RUN_DB_TESTS=1.');
  assert.match(schema, /^ur_bundle_test_[a-f0-9]{32}$/);
  const connection = new URL(originalDatabaseUrl);
  assert.ok(['127.0.0.1', 'localhost', 'db', '[::1]'].includes(connection.hostname), 'This test only accepts the local development database.');
  assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), 'Supply an absolute real-bundle path.');
  const bundle = JSON.parse(await readFile(process.argv[2], 'utf8')) as AnalysisBundle;
  assert.equal(bundle.game.id, '2026_01_ATL_PIT', 'This bounded acceptance test uses the real ATL–PIT catch-up bundle.');
  assert.ok(bundle.analysis.metrics.length > 0);

  directory = await mkdtemp(path.join(os.tmpdir(), 'under-review-bundle-real-'));
  config.dataDir = directory;
  admin = new pg.Client({ connectionString: originalDatabaseUrl, connectionTimeoutMillis: 5000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  connection.searchParams.set('options', `-c search_path=${schema}`);
  config.databaseUrl = connection.toString();
  // Import only after setting the isolated connection, before any shared pool exists.
  assert.equal((globalThis as { urPool?: pg.Pool }).urPool, undefined);
  db = await import('../packages/core/src/db.js');
  assert.equal((await db.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  await db.migrate();
  const { importAnalysisBundle } = await import('../packages/core/src/analysis-bundle.js');
  const { getReport, stableJson } = await import('../packages/core/src/repository.js');

  const first = await importAnalysisBundle(bundle);
  assert.equal(first.created, true);
  assert.equal(first.number, 1);
  const report = await getReport(bundle.game.id);
  assert.ok(report);
  assert.equal(stableJson(report.game), stableJson(bundle.game));
  assert.equal(stableJson(report.revision.analysis), stableJson(bundle.analysis));
  assert.equal(report.revision.sourceSnapshots.length, bundle.snapshots.length);
  assert.equal(report.revision.reviewStatus, 'not_reviewed');
  const storedPlays = (await db.query('SELECT snapshot_id,data FROM plays WHERE game_id=$1 ORDER BY provider_order', [bundle.game.id])).rows;
  assert.equal(stableJson(storedPlays.map(row => row.data)), stableJson(bundle.plays));
  const pbpId = bundle.snapshots.find(item => item.snapshot.provider === 'nflverse-pbp')!.snapshot.id;
  assert.ok(storedPlays.every(row => row.snapshot_id === pbpId));
  const root = await realpath(directory);
  for (const source of report.revision.sourceSnapshots) {
    assert.equal(await realpath(source.path), path.join(root, 'snapshots', 'snapshots', `${source.checksum}.csv`));
    const bytes = await readFile(source.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.checksum);
    const original = bundle.snapshots.find(item => item.snapshot.id === source.id)!;
    assert.equal(bytes.toString('base64'), original.bytesBase64);
    const { path: ignoredPath, ...metadata } = source;
    assert.equal(stableJson(metadata), stableJson(original.snapshot));
  }
  assert.equal((await db.query('SELECT publication_eligible FROM games WHERE id=$1', [bundle.game.id])).rows[0].publication_eligible, false);

  // Even an otherwise identical import must atomically suppress publication.
  await db.query('UPDATE games SET publication_eligible=true WHERE id=$1', [bundle.game.id]);
  const second = await importAnalysisBundle(bundle);
  assert.deepEqual(second, { ...first, created: false });
  assert.equal((await db.query('SELECT publication_eligible FROM games WHERE id=$1', [bundle.game.id])).rows[0].publication_eligible, false);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM analysis_revisions')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM source_snapshots')).rows[0].n, bundle.snapshots.length);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM plays')).rows[0].n, bundle.plays.length);
  for (const table of ['users', 'reviews', 'jobs', 'publication_outbox', 'publication_attempts']) {
    assert.equal((await db.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0);
  }
  console.log(JSON.stringify({ result: 'passed', gameId: bundle.game.id, bundleChecksum: bundle.checksum, metrics: bundle.analysis.metrics.length, plays: bundle.plays.length, snapshots: bundle.snapshots.length, revisions: 1, idempotent: true, publicationEligible: false }));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  await db?.pool.end();
  if (admin) {
    try {
      assert.match(schema, /^ur_bundle_test_[a-f0-9]{32}$/);
      if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await admin.end(); }
  }
  config.databaseUrl = originalDatabaseUrl;
  config.dataDir = originalDataDir;
  if (directory) {
    const parent = await realpath(os.tmpdir());
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^under-review-bundle-real-[A-Za-z0-9]+$/);
    await rm(resolved, { recursive: true });
  }
}
