import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceSnapshot } from './contracts.js';
export type { SourceSnapshot } from './contracts.js';

export interface SourceRequest {
  provider: string;
  url: string;
  license: string;
  extension?: 'csv' | 'rds' | 'json';
  metadata?: Record<string, unknown>;
}

export interface SnapshotStore {
  fetch(source: SourceRequest, options?: { maxAgeMs?: number; force?: boolean }): Promise<SourceSnapshot>;
  read(snapshot: SourceSnapshot): Promise<Buffer>;
}

export class SourceError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'SourceError';
  }
}

type CacheRecord = { snapshot: SourceSnapshot; checkedAt: string; etag?: string; lastModified?: string };
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const RELEASE_ROOTS = ['/nflverse/nflverse-data/releases/download/', '/nflverse/nflverse-pbp/releases/download/'];

/** Initial requests are restricted to known public datasets; redirect hosts are GitHub's release CDN. */
export function assertSourceUrl(value: string, redirected = false): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new SourceError('source_url_rejected', 'Only HTTPS public dataset URLs are permitted.');
  }
  const release = url.hostname === 'github.com' && RELEASE_ROOTS.some((prefix) => url.pathname.startsWith(prefix));
  const cdn = redirected && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
  if (!release && !cdn) throw new SourceError('source_url_rejected', 'Source host or path is outside the dataset allowlist.');
  return url;
}

/** Content-addressed immutable bytes plus a small per-URL conditional-request index. */
export class LocalSnapshotStore implements SnapshotStore {
  readonly root: string;
  private readonly active = new Map<string, Promise<SourceSnapshot>>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(root: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}) {
    this.root = path.resolve(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxBytes = options.maxBytes ?? 160 * 1024 * 1024;
  }

  async read(snapshot: SourceSnapshot): Promise<Buffer> {
    const file = path.resolve(snapshot.path);
    const relative = path.relative(this.root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SourceError('snapshot_path_rejected', 'Snapshot lies outside its store.');
    const bytes = await readFile(file);
    if (sha256(bytes) !== snapshot.checksum) throw new SourceError('snapshot_checksum_mismatch', 'Stored snapshot failed its checksum.');
    return bytes;
  }

  fetch(source: SourceRequest, options: { maxAgeMs?: number; force?: boolean } = {}): Promise<SourceSnapshot> {
    assertSourceUrl(source.url);
    const existing = this.active.get(source.url);
    if (existing) return existing;
    const pending = this.download(source, options).finally(() => this.active.delete(source.url));
    this.active.set(source.url, pending);
    return pending;
  }

  private async download(source: SourceRequest, options: { maxAgeMs?: number; force?: boolean }): Promise<SourceSnapshot> {
    const indexPath = path.join(this.root, 'index', `${sha256(source.url)}.json`);
    let cached: CacheRecord | undefined;
    try {
      const candidate = JSON.parse(await readFile(indexPath, 'utf8')) as CacheRecord;
      if (candidate.snapshot.url === source.url) {
        await this.read(candidate.snapshot);
        cached = candidate;
      }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SourceError('snapshot_index_invalid', 'Stored snapshot metadata could not be read.');
      }
    }
    if (cached && !options.force && Date.now() - Date.parse(cached.checkedAt) < (options.maxAgeMs ?? 300_000)) return cached.snapshot;

    const headers: Record<string, string> = { 'User-Agent': 'UnderReview/1.0 (nflverse dataset reader)', Accept: '*/*' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response | undefined;
    let target = source.url;
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        assertSourceUrl(target, redirects > 0);
        response = await this.fetchImpl(target, { headers, redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 5) throw new SourceError('source_redirect_invalid', 'Dataset redirect limit exceeded.');
          target = new URL(location, target).href;
          continue;
        }
        break;
      }
      if (!response) throw new SourceError('source_network_error', 'Dataset returned no response.', true);
      const checkedAt = new Date().toISOString();
      if (response.status === 304 && cached) {
        await this.writeIndex(indexPath, { ...cached, checkedAt });
        return cached.snapshot;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError(`source_http_${response.status}`, `Dataset request failed with HTTP ${response.status}.`, response.status === 429 || response.status >= 500 || response.status === 404);
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > this.maxBytes) throw new SourceError('source_too_large', 'Dataset exceeds the configured byte limit.');
      const chunks: Buffer[] = [];
      let length = 0;
      if (!response.body) throw new SourceError('source_empty', 'Dataset response was empty.', true);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > this.maxBytes) {
            await reader.cancel();
            throw new SourceError('source_too_large', 'Dataset exceeds the configured byte limit.');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      if (!length) throw new SourceError('source_empty', 'Dataset response was empty.', true);
      const bytes = Buffer.concat(chunks);
      const checksum = sha256(bytes);
      if (cached && cached.snapshot.checksum === checksum) {
        await this.writeIndex(indexPath, { ...cached, checkedAt, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined });
        return cached.snapshot;
      }
      const id = sha256(`${source.url}\n${checksum}`);
      const file = path.join(this.root, 'snapshots', `${checksum}.${source.extension ?? 'csv'}`);
      await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const lastModified = response.headers.get('last-modified') ?? undefined;
      const snapshot: SourceSnapshot = {
        id, provider: source.provider, url: source.url, retrievedAt: checkedAt, checksum,
        providerVersion: lastModified, path: file, license: source.license,
        metadata: { ...source.metadata, bytes: length, etag: response.headers.get('etag'), lastModified: lastModified ?? null },
      };
      await this.writeIndex(indexPath, { snapshot, checkedAt, etag: response.headers.get('etag') ?? undefined, lastModified });
      return snapshot;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      // Never include signed CDN query strings or arbitrary response bodies in logs/errors.
      throw new SourceError('source_network_error', 'Dataset download failed or timed out.', true);
    }
  }

  private async writeIndex(file: string, record: CacheRecord): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  }
}

export const SOURCE_LICENSES = {
  nflverse: 'CC-BY-4.0',
  ftn: 'CC-BY-SA-4.0',
} as const;

export const sourceUrls = {
  schedules: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
  clean: (season: number): string => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv`,
  raw: (gameId: string): string => `https://github.com/nflverse/nflverse-pbp/releases/download/raw_pbp_${gameId.slice(0, 4)}/${gameId}.rds`,
  ftn: (season: number): string => `https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_${season}.csv`,
};
