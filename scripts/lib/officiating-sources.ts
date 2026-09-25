import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import type { CorpusGame } from '../build-officiating-corpus.js';

export interface CorpusSource {
  url: string;
  checksum: string;
  license: 'CC-BY-4.0';
  attribution: string;
  bytes: number;
  retrievedAt?: string;
  lastModified?: string | null;
  etag?: string | null;
  origin: 'snapshot' | 'overtime-cache' | 'officiating-cache' | 'download' | 'frozen';
}

export async function checksumFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function checksumBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function storedSnapshot(root: string, url: string): Promise<{ file: string; source: CorpusSource } | null> {
  const directory = path.join(root, 'data/snapshots');
  let names: string[];
  try { names = await readdir(path.join(directory, 'index')); } catch { return null; }
  const matches = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const index = JSON.parse(await readFile(path.join(directory, 'index', name), 'utf8'));
    if (index.snapshot?.url === url) matches.push(index.snapshot);
  }
  matches.sort((a, b) => String(b.retrievedAt).localeCompare(String(a.retrievedAt)));
  for (const entry of matches) {
    if (!/^[a-f0-9]{64}$/.test(entry.checksum)) throw new Error('Invalid snapshot checksum');
    const file = path.join(directory, 'snapshots', `${entry.checksum}.csv`);
    let size: number;
    try { size = (await stat(file)).size; } catch { continue; }
    if (!size || await checksumFile(file) !== entry.checksum) throw new Error(`Snapshot checksum mismatch: ${url}`);
    return { file, source: { url, checksum: entry.checksum, license: 'CC-BY-4.0', attribution: entry.metadata?.attribution ?? 'nflverse / nflfastR', bytes: size,
      retrievedAt: entry.retrievedAt, lastModified: entry.metadata?.lastModified, etag: entry.metadata?.etag, origin: 'snapshot' } };
  }
  return null;
}

/** Downloads are opt-in; every reused local source is checked against recorded bytes. */
export async function publicPbpSource(root: string, season: number, downloadMissing: boolean, refreshCurrent = false): Promise<{ file: string; source: CorpusSource }> {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv`;
  if (season === 2026) {
    const current = await currentPublicSource(root, 'pbp', refreshCurrent);
    if (current) return current;
  }
  const snapshot = await storedSnapshot(root, url);
  if (snapshot) return snapshot;
  const overtime = JSON.parse(await readFile(path.join(root, 'analytics/models/overtime-reference.json'), 'utf8'));
  const expected = overtime.sources.find((source: { season: number }) => source.season === season);
  const existing = path.join(root, `data/overtime-sources/play_by_play_${season}.csv`);
  let oldSize: number | null = null;
  try { oldSize = (await stat(existing)).size; } catch { /* This season was not retained. */ }
  if (oldSize && expected) {
    if (await checksumFile(existing) !== expected.checksum) throw new Error(`Overtime source checksum mismatch: ${season}`);
    return { file: existing, source: { url, checksum: expected.checksum, license: 'CC-BY-4.0', attribution: 'nflverse / nflfastR', bytes: oldSize, origin: 'overtime-cache' } };
  }
  const metadataFile = path.join(root, 'data/officiating-sources', `play_by_play_${season}.source.json`);
  const saved = await cachedPublicSource(metadataFile, url);
  if (saved) return saved;
  if (!downloadMissing) throw new Error(`No verified play-by-play for ${season}; use --download-missing to fetch the public nflverse CSV.`);
  return downloadPublicSource(metadataFile, url, 'nflverse / nflfastR', 100_000);
}

async function cachedPublicSource(metadataFile: string, url: string): Promise<{ file: string; source: CorpusSource } | null> {
  let saved: CorpusSource | null = null;
  try { saved = JSON.parse(await readFile(metadataFile, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (saved) {
    if (saved.url !== url || !/^[a-f0-9]{64}$/.test(saved.checksum)) throw new Error(`Invalid cached metadata: ${url}`);
    const file = path.join(path.dirname(metadataFile), `${saved.checksum}.csv`);
    if (await checksumFile(file) !== saved.checksum || (await stat(file)).size !== saved.bytes) throw new Error(`Cached source checksum mismatch: ${url}`);
    return { file, source: { ...saved, origin: 'officiating-cache' } };
  }
  return null;
}

async function downloadPublicSource(metadataFile: string, url: string, attribution: string, minimumBytes: number): Promise<{ file: string; source: CorpusSource }> {
  const cache = path.dirname(metadataFile);
  await mkdir(cache, { recursive: true });
  const temporary = path.join(cache, `${randomUUID()}.partial`);
  console.log(JSON.stringify({ downloading: url }));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Public source ${url}: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (/html/i.test(contentType)) throw new Error(`Public source ${url} is HTML`);
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temporary, { flags: 'wx' }));
    const bytes = (await stat(temporary)).size;
    if (bytes < minimumBytes) throw new Error(`Unexpectedly small public source: ${url}`);
    const checksum = await checksumFile(temporary);
    const source: CorpusSource = { url, checksum, license: 'CC-BY-4.0', attribution, bytes,
      retrievedAt: new Date().toISOString(), lastModified: response.headers.get('last-modified'), etag: response.headers.get('etag'), origin: 'download' };
    const file = path.join(cache, `${checksum}.csv`);
    let exists = false;
    try { await stat(file); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      if (await checksumFile(file) !== checksum) throw new Error('Content-addressed source cache corruption');
    } else await rename(temporary, file);
    await writeAtomic(metadataFile, JSON.stringify(source, null, 2) + '\n');
    return { file, source };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Explicit current-season refresh; old checksum-addressed CSVs are never replaced. */
export async function currentPublicSource(root: string, kind: 'pbp' | 'schedules' | 'team-stats', refresh = false): Promise<{ file: string; source: CorpusSource } | null> {
  const urls = {
    pbp: 'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.csv',
    schedules: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
    'team-stats': 'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2026.csv',
  };
  const url = urls[kind], metadataFile = path.join(root, 'data/officiating-sources', `current-${kind}-2026.source.json`);
  if (refresh) return downloadPublicSource(metadataFile, url, kind === 'schedules' ? 'Lee Sharpe and nflverse' : 'nflverse / nflfastR', kind === 'team-stats' ? 1000 : 100_000);
  return await cachedPublicSource(metadataFile, url) ?? await storedSnapshot(root, url);
}

/** Read verified observations in game chronology; no source network requests. */
export async function readOfficiatingCorpus(root: string, seasons: number[]): Promise<CorpusGame[]> {
  const games: CorpusGame[] = [], ids = new Set<string>();
  const extractorChecksum = await checksumFile(path.join(root, 'packages/core/src/officiating-observations.ts'));
  const builderChecksum = await checksumFile(path.join(root, 'scripts/build-officiating-corpus.ts'));
  const aliases = JSON.parse(await readFile(path.join(root, 'packages/core/reference/expectations-reference.json'), 'utf8')).aliases;
  const aliasesChecksum = checksumBytes(Buffer.from(JSON.stringify(aliases)));
  for (const season of [...seasons].sort((a, b) => a - b)) {
    if (!Number.isInteger(season) || season < 2015 || season > 2026) throw new Error('Unsupported corpus season');
    const directory = path.join(root, 'data/officiating-corpus');
    const metadata = JSON.parse(await readFile(path.join(directory, `season-${season}.metadata.json`), 'utf8'));
    const bytes = gunzipSync(await readFile(path.join(directory, `season-${season}.json.gz`)));
    if (checksumBytes(bytes) !== metadata.checksum) throw new Error(`Corpus checksum mismatch: ${season}`);
    const artifact = JSON.parse(bytes.toString('utf8'));
    if (artifact.schemaVersion !== 1 || artifact.season !== season || artifact.extractorChecksum !== extractorChecksum || artifact.builderChecksum !== builderChecksum || artifact.aliasesChecksum !== aliasesChecksum) throw new Error(`Stale or incompatible corpus: ${season}; rebuild this season.`);
    for (const entry of artifact.games as CorpusGame[]) {
      if (entry.game.season !== season || ids.has(entry.game.id)) throw new Error(`Corpus game identity mismatch: ${entry.game.id}`);
      ids.add(entry.game.id);
      games.push(entry);
    }
  }
  return games.sort((a, b) => a.game.season - b.game.season || (a.game.kickoffAt ?? '').localeCompare(b.game.kickoffAt ?? '') || a.game.week - b.game.week || a.game.id.localeCompare(b.game.id));
}
