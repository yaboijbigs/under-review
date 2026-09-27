import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Game, SourceSnapshot } from '../packages/core/src/contracts.js';
import { ASSIGNMENT_SOURCE_LICENSE, assignmentSourceUrls, fetchRefereeAssignments, footballZebrasArticleUrl, parseFootballZebrasAssignments, parseSharpFootballAssignments } from '../packages/core/src/referee-assignment-sources.js';
import { LocalSnapshotStore, SourceError, assertSourceUrl, type SnapshotStore, type SourceRequest } from '../packages/core/src/sources.js';

const games: Game[] = [
  { id: '2026_03_ATL_GB', season: 2026, week: 3, gameType: 'REG', awayTeam: 'ATL', homeTeam: 'GB', awayScore: null, homeScore: null, kickoffAt: '2026-09-24T20:15:00Z', providerData: {} },
  { id: '2026_03_BAL_DAL', season: 2026, week: 3, gameType: 'REG', awayTeam: 'BAL', homeTeam: 'DAL', awayScore: null, homeScore: null, kickoffAt: '2026-09-27T20:25:00Z', providerData: {} },
];
// Reduced to assignment facts and the structural wrappers observed in the public
// Week 3 articles on 2026-09-27; publisher commentary is intentionally excluded.
function zebras(markup = '<div class="b_post-game">Falcons at Packers</div>\n<div class="b_post-referee">Shawn Smith</div><div class="b_post-time">8:15 p.m.</div><div class="b_post-game">Ravens vs. Cowboys</div><div class="b_post-referee">John Hussey</div>') {
  return [{ id: 56939, date_gmt: '2026-09-22T17:14:02', modified_gmt: '2026-09-22T17:14:21', link: 'https://www.footballzebras.com/2026/09/week-3-referee-assignments-2026/', title: { rendered: 'Week 3 referee assignments' }, content: { rendered: `<p>Unrelated article copy.</p><div class="assignment_list"><h3>Thursday, Sep. 8</h3>${markup}</div>` } }];
}
function sharp(rows = '<tr><td>Falcons at Packers</td><td>Shawn Smith</td></tr><tr><td>Ravens vs. Cowboys</td><td>John Hussey</td></tr>') {
  return `<script type="application/ld+json">{"@context":"https://schema.org/","@type":"NewsArticle","datePublished":"2026-09-27T09:30:02-04:00","dateModified":"2026-09-27T10:16:48-04:00"}</script><p>Throughout this 2026 NFL season, we'll help.</p><table id='jtrt_table_56102'><thead><tr><th>Week 3</th><th>Referee</th></tr></thead><tbody>${rows}</tbody></table><table><tr><th>Unrelated table</th></tr><tr><td>Other content</td></tr></table>`;
}
const expected = [{ gameId: '2026_03_ATL_GB', name: 'Shawn Smith' }, { gameId: '2026_03_BAL_DAL', name: 'John Hussey' }];
const directories: string[] = [];
async function temporary() { const directory = await mkdtemp(path.join(tmpdir(), 'ur-assignment-test-')); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('pregame referee assignment parsing', () => {
  it('matches exact schedule identities rather than mistaken article dates or neutral-site wording', () => {
    expect(parseFootballZebrasAssignments(zebras(), 2026, 3, games)).toEqual(expected);
    expect(parseSharpFootballAssignments(sharp(), 2026, 3, games)).toEqual(expected);
    expect(parseFootballZebrasAssignments(zebras(), 2026, 3, games.slice(0, 1))).toEqual(expected.slice(0, 1));
    expect(footballZebrasArticleUrl(zebras(), 2026, 3)).toBe(zebras()[0].link);
  });
  it('decodes entities and harmless inline markup and uses historical franchise aliases', () => {
    const game = { ...games[0], awayTeam: 'JAC', homeTeam: 'LAR' };
    expect(parseFootballZebrasAssignments(zebras('<div class="b_post-game">Jacksonville Jaguars at Los Angeles Rams</div><div class="b_post-referee"><strong>Shawn&nbsp;Smith</strong></div>'), 2026, 3, [game])).toEqual([expected[0]]);
  });
  it('does not reuse a wrong week or season or a different WordPress article', () => {
    const wrong = zebras(); wrong[0].link = wrong[0].link.replace('2026/09', '2025/09');
    expect(() => parseFootballZebrasAssignments(wrong, 2026, 3, games)).toThrow();
    expect(() => parseFootballZebrasAssignments([], 2026, 3, games)).toThrow();
    expect(() => parseFootballZebrasAssignments([...zebras(), ...zebras()], 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace('Week 3', 'Week 2'), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace('this 2026 NFL', 'this 2025 NFL'), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replaceAll('2026-09-27', '2025-09-27'), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace(/<script[\s\S]*?<\/script>/, ''), 2026, 3, games)).toThrow();
  });
  it('accepts January publication for the preceding regular season, keeping the season in the slug', () => {
    const post = zebras(), lateGames = games.map((game) => ({ ...game, week: 18 }));
    post[0].title.rendered = 'Week 18 referee assignments';
    post[0].link = 'https://www.footballzebras.com/2027/01/week-18-referee-assignments-2026/';
    expect(parseFootballZebrasAssignments(post, 2026, 18, lateGames)).toEqual(expected);
    for (const link of [
      'https://www.footballzebras.com/2027/09/week-18-referee-assignments-2026/',
      'https://www.footballzebras.com/2026/01/week-18-referee-assignments-2026/',
      'https://www.footballzebras.com/2027/01/week-18-referee-assignments-2027/',
    ]) expect(() => parseFootballZebrasAssignments([{ ...post[0], link }], 2026, 18, lateGames)).toThrow();
  });
  it('rejects duplicate and ambiguous rows, unknown teams and malformed referee columns', () => {
    expect(() => parseSharpFootballAssignments(sharp('<tr><td>Falcons at Packers</td><td>Shawn Smith</td></tr>'.repeat(2)), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp(), 2026, 3, [...games, { ...games[0], id: 'duplicate' }])).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace('Falcons at Packers', 'Unknown at Packers'), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace('Shawn Smith', '8:15 p.m.'), 2026, 3, games)).toThrow();
    expect(() => parseFootballZebrasAssignments(zebras().map((post) => ({ ...post, content: { rendered: post.content.rendered.replace('b_post-referee', 'new-layout') } })), 2026, 3, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp().replace('</table>', '</table>' + sharp()), 2026, 3, games)).toThrow();
  });
  it('keeps explicit TBD rows missing and excludes postseason games', () => {
    expect(parseSharpFootballAssignments(sharp().replace('Shawn Smith', 'TBD'), 2026, 3, games)).toEqual([expected[1]]);
    expect(() => parseFootballZebrasAssignments(zebras(), 2026, 3, games.map((game) => ({ ...game, gameType: 'WC' })))).toThrow();
    expect(() => parseFootballZebrasAssignments(zebras(), 2026, 19, games)).toThrow();
    expect(() => parseSharpFootballAssignments(sharp(), 2026, 3, [{ ...games[0], awayTeam: 'KC' }])).toThrow();
  });
});

describe('assignment source fetching and provenance', () => {
  function memoryStore(fail?: string): SnapshotStore {
    const content = new Map<string, Buffer>();
    return {
      fetch: vi.fn(async (request: SourceRequest): Promise<SourceSnapshot> => {
        if (request.provider === fail) throw new SourceError('source_http_503', 'Unavailable', true);
        const bytes = Buffer.from(request.provider === 'football-zebras' ? JSON.stringify(zebras()) : sharp());
        const checksum = createHash('sha256').update(bytes).digest('hex');
        content.set(checksum, bytes);
        return { id: createHash('sha256').update(`${request.url}\n${checksum}`).digest('hex'), provider: request.provider, url: request.url, retrievedAt: '2026-09-27T22:00:00Z', checksum, path: checksum, license: request.license, metadata: request.metadata };
      }),
      read: async (snapshot) => content.get(snapshot.checksum)!,
    };
  }
  it('fetches both independent sources, preserves disagreement, and records only verified article URLs', async () => {
    const store = memoryStore(), originalRead = store.read;
    store.read = async (snapshot) => Buffer.from((await originalRead(snapshot)).toString().replace(snapshot.provider === 'sharp-football' ? 'Shawn Smith' : 'NOT PRESENT', 'John Hussey'));
    const result = await fetchRefereeAssignments(2026, 3, games, store);
    expect(result.assignments).toHaveLength(4);
    expect(result.assignments.filter((assignment) => assignment.gameId === games[0].id).map((assignment) => assignment.name)).toEqual(['Shawn Smith', 'John Hussey']);
    expect(result.warnings).toEqual([]);
    expect(result.snapshots[0].metadata?.articleUrl).toBe(zebras()[0].link);
    expect(result.snapshots[1].metadata?.articleUrl).toBe(assignmentSourceUrls.sharpFootball);
    expect(result.snapshots.every((snapshot) => snapshot.license === ASSIGNMENT_SOURCE_LICENSE)).toBe(true);
    expect(store.fetch).toHaveBeenCalledWith(expect.anything(), { maxAgeMs: 900_000 });
  });
  it.each(['football-zebras', 'sharp-football'])('uses the surviving source when %s is unavailable', async (provider) => {
    const result = await fetchRefereeAssignments(2026, 3, games, memoryStore(provider));
    expect(result.assignments).toHaveLength(2);
    expect(result.snapshots).toHaveLength(1);
    expect(result.warnings).toEqual([`${provider}: source_http_503`]);
    expect(result.assignments.some((assignment) => assignment.provider === provider)).toBe(false);
  });
  it('does not return a malformed source snapshot as a successful refresh', async () => {
    const store = memoryStore(), read = store.read;
    store.read = async (snapshot) => snapshot.provider === 'sharp-football' ? Buffer.from(sharp().replace('Week 3', 'Week 2')) : read(snapshot);
    const result = await fetchRefereeAssignments(2026, 3, games, store);
    expect(result.snapshots.map((snapshot) => snapshot.provider)).toEqual(['football-zebras']);
    expect(result.warnings).toEqual(['sharp-football: assignment_table_scope_mismatch']);
  });
  it('reuses cached immutable bytes and bounds a timed-out publisher independently', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).includes('footballzebras')) return new Response(JSON.stringify(zebras()));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    });
    const store = new LocalSnapshotStore(await temporary(), { fetchImpl: transport, timeoutMs: 25, maxBytes: 2 * 1024 * 1024 });
    const first = await fetchRefereeAssignments(2026, 3, games, store);
    expect(first.assignments).toHaveLength(2);
    expect(first.warnings).toEqual(['sharp-football: source_network_error']);
    const second = await fetchRefereeAssignments(2026, 3, games, store);
    expect(second.snapshots[0].id).toBe(first.snapshots[0].id);
    expect(transport.mock.calls.filter(([input]) => String(input).includes('footballzebras'))).toHaveLength(1);
  });
  it('allows only the exact public assignment endpoint shapes', () => {
    expect(() => assertSourceUrl(assignmentSourceUrls.footballZebras(2026, 3))).not.toThrow();
    expect(() => assertSourceUrl(assignmentSourceUrls.sharpFootball)).not.toThrow();
    for (const url of [assignmentSourceUrls.footballZebras(2026, 3) + '&context=edit', assignmentSourceUrls.footballZebras(2026, 3).replace('posts?', 'users?'), assignmentSourceUrls.footballZebras(2026, 3).replace('week-3-', 'week-30-'), assignmentSourceUrls.sharpFootball + '?private=true', assignmentSourceUrls.sharpFootball.replace('www.', '')]) expect(() => assertSourceUrl(url)).toThrow();
  });
});
