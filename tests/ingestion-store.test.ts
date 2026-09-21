import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSnapshotStore, assertSourceUrl, sourceUrls } from '../packages/core/src/sources.js';
import { AnalyticsEngineError, runRRequest } from '../packages/core/src/analytics-bridge.js';

const directories: string[] = [];
async function temporary() { const result = await mkdtemp(path.join(tmpdir(), 'ur-source-test-')); directories.push(result); return result; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const request = { provider: 'nflverse-pbp', url: sourceUrls.clean(2023), license: 'CC-BY-4.0', extension: 'csv' as const };

describe('immutable conditional source snapshots', () => {
  it('reuses an unchanged snapshot after a conditional 304 and preserves old bytes on correction', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('game_id,play_id\ngame,1\n', { status: 200, headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response('game_id,play_id\ngame,2\n', { status: 200, headers: { ETag: '"v2"' } }));
    const store = new LocalSnapshotStore(await temporary(), { fetchImpl: transport });
    const initial = await store.fetch(request);
    const same = await store.fetch(request, { force: true });
    expect(same.id).toBe(initial.id);
    expect(transport.mock.calls[1][1]?.headers).toMatchObject({ 'If-None-Match': '"v1"' });
    const changed = await store.fetch(request, { force: true });
    expect(changed.id).not.toBe(initial.id);
    expect((await store.read(initial)).toString()).toContain('game,1');
    expect((await store.read(changed)).toString()).toContain('game,2');
  });
  it('coalesces simultaneous downloads and checks its memory limit', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('a,b\n1,2\n'));
    const store = new LocalSnapshotStore(await temporary(), { fetchImpl: transport });
    const [one, two] = await Promise.all([store.fetch(request), store.fetch(request)]);
    expect(one.id).toBe(two.id);
    expect(transport).toHaveBeenCalledTimes(1);
    const limited = new LocalSnapshotStore(await temporary(), { maxBytes: 3, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('1234')) });
    await expect(limited.fetch(request)).rejects.toMatchObject({ code: 'source_too_large' });
  });
  it('blocks untrusted hosts, credentials and redirects to local services', async () => {
    for (const url of ['http://github.com/nflverse/nflverse-data/releases/download/pbp/a.csv', 'https://127.0.0.1/private', 'https://github.com/other/repo/releases/download/a.csv', 'https://user:password@github.com/nflverse/nflverse-data/releases/download/pbp/a.csv']) expect(() => assertSourceUrl(url)).toThrow();
    const store = new LocalSnapshotStore(await temporary(), { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secrets' } })) });
    await expect(store.fetch(request)).rejects.toMatchObject({ code: 'source_url_rejected' });
  });
  it('reports missing R honestly and rejects non-finite JSON inputs', async () => {
    await expect(runRRequest({ schemaVersion: 1, action: 'analyze' }, { rscript: path.join(await temporary(), 'does-not-exist') })).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(runRRequest({ score: Infinity })).rejects.toBeInstanceOf(AnalyticsEngineError);
  });
});
