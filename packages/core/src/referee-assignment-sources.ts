import path from 'node:path';
import { config } from './config.js';
import type { Game, SourceSnapshot } from './contracts.js';
import { LocalSnapshotStore, SourceError, type SnapshotStore } from './sources.js';

export const ASSIGNMENT_SOURCE_LICENSE = 'Public assignment facts; publisher copyright';
export const assignmentSourceUrls = {
  footballZebras: (season: number, week: number): string => `https://www.footballzebras.com/wp-json/wp/v2/posts?slug=week-${week}-referee-assignments-${season}&_fields=id,date_gmt,modified_gmt,link,title,content`,
  sharpFootball: 'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/',
};
export type AssignmentProvider = 'football-zebras' | 'sharp-football';
export interface ParsedRefereeAssignment { gameId: string; name: string }
export interface FetchedRefereeAssignment extends ParsedRefereeAssignment { provider: AssignmentProvider; snapshot: SourceSnapshot }

// Only these franchise identities are accepted; a renamed/malformed row cannot create a game.
const TEAM_NAMES: Record<string, string> = {
  cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI', bengals: 'CIN', browns: 'CLE', cowboys: 'DAL', broncos: 'DEN', lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND', jaguars: 'JAX', chiefs: 'KC', raiders: 'LV', chargers: 'LAC', rams: 'LA', dolphins: 'MIA', vikings: 'MIN', patriots: 'NE', saints: 'NO', giants: 'NYG', jets: 'NYJ', eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', seahawks: 'SEA', buccaneers: 'TB', titans: 'TEN', commanders: 'WAS', redskins: 'WAS', 'football team': 'WAS',
};
const TEAM_ALIASES: Record<string, string> = { JAC: 'JAX', LAR: 'LA', OAK: 'LV', SD: 'LAC', STL: 'LA', WSH: 'WAS' };
const normalizeTeam = (team: string): string => TEAM_ALIASES[team] ?? team;

function invalid(code: string): never { throw new SourceError(code, 'Referee assignment article could not be validated.'); }
function scope(season: number, week: number, games: Game[]): Game[] {
  if (!Number.isInteger(season) || season < 1999 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18) invalid('assignment_scope_unsupported');
  const eligible = games.filter((game) => game.season === season && game.week === week && game.gameType === 'REG');
  if (!eligible.length || new Set(eligible.map((game) => game.id)).size !== eligible.length) invalid('assignment_schedule_invalid');
  return eligible;
}
function text(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_match, value: string) => {
      const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_match, entity: string) => ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[entity.toLowerCase()] ?? '')
    .replace(/\s+/g, ' ').trim();
}
function teamName(value: string): string | undefined {
  const normalized = value.toLowerCase().trim();
  return TEAM_NAMES[normalized] ?? Object.entries(TEAM_NAMES).find(([nickname]) => normalized.endsWith(` ${nickname}`))?.[1];
}
function matchRows(rows: Array<[string, string]>, games: Game[]): ParsedRefereeAssignment[] {
  if (!rows.length || rows.length > 16) invalid('assignment_rows_invalid');
  const result: ParsedRefereeAssignment[] = [], matchups = new Set<string>();
  for (const [matchup, rawName] of rows) {
    const parts = matchup.split(/\s+(?:at|vs\.?|versus)\s+/i);
    if (parts.length !== 2) invalid('assignment_matchup_invalid');
    const away = teamName(parts[0]), home = teamName(parts[1]);
    if (!away || !home || away === home) invalid('assignment_team_invalid');
    const key = `${away}_${home}`;
    if (matchups.has(key)) invalid('assignment_duplicate_game');
    matchups.add(key);
    const matches = games.filter((game) => normalizeTeam(game.awayTeam) === away && normalizeTeam(game.homeTeam) === home);
    if (matches.length > 1) invalid('assignment_schedule_ambiguous');
    const name = rawName.replace(/\s+/g, ' ').trim();
    if (/^(?:TBD|TBA|to be (?:announced|determined)|not announced|—|-)$/i.test(name)) continue;
    if (!/^[A-Z][A-Za-z.'’\-]+(?: [A-Za-z][A-Za-z.'’\-]+){1,4}$/.test(name)) invalid('assignment_referee_invalid');
    if (matches.length) result.push({ gameId: matches[0].id, name });
  }
  // A target-only replay may legitimately find an unannounced assignment, but a
  // completely unrelated table is never accepted as a successful source refresh.
  if (!games.some((game) => matchups.has(`${normalizeTeam(game.awayTeam)}_${normalizeTeam(game.homeTeam)}`))) invalid('assignment_schedule_mismatch');
  return result;
}

type ZebrasPost = { link: string; title: { rendered: string }; content: { rendered: string } };
function zebrasPost(payload: unknown, season: number, week: number): ZebrasPost {
  if (!Array.isArray(payload) || payload.length !== 1) invalid('assignment_article_unavailable');
  const post = payload[0] as Partial<ZebrasPost> | null;
  if (!post || typeof post.link !== 'string' || typeof post.title?.rendered !== 'string' || typeof post.content?.rendered !== 'string') invalid('assignment_article_invalid');
  const expected = new RegExp(`^https://www\\.footballzebras\\.com/(?:${season}/(?:0[89]|1[0-2])|${season + 1}/0[12])/week-${week}-referee-assignments-${season}/$`);
  if (!expected.test(post.link) || !new RegExp(`^Week ${week} referee assignments$`, 'i').test(text(post.title.rendered))) invalid('assignment_article_scope_mismatch');
  return post as ZebrasPost;
}
export function footballZebrasArticleUrl(payload: unknown, season: number, week: number): string { return zebrasPost(payload, season, week).link; }
export function parseFootballZebrasAssignments(payload: unknown, season: number, week: number, games: Game[]): ParsedRefereeAssignment[] {
  const eligible = scope(season, week, games), html = zebrasPost(payload, season, week).content.rendered;
  const gameDiv = '<div\\b[^>]*class=["\'][^"\']*\\bb_post-game\\b[^"\']*["\'][^>]*>';
  const refereeDiv = '<div\\b[^>]*class=["\'][^"\']*\\bb_post-referee\\b[^"\']*["\'][^>]*>';
  const rows = [...html.matchAll(new RegExp(`${gameDiv}([\\s\\S]*?)<\\/div>\\s*${refereeDiv}([\\s\\S]*?)<\\/div>`, 'gi'))].map((match): [string, string] => [text(match[1]), text(match[2])]);
  if (rows.length !== [...html.matchAll(new RegExp(gameDiv, 'gi'))].length) invalid('assignment_layout_changed');
  return matchRows(rows, eligible);
}

function sharpSeason(html: string, season: number): void {
  if (!new RegExp(`Throughout this ${season} NFL season\\b`, 'i').test(text(html))) invalid('assignment_article_season_mismatch');
  const dates: string[] = [];
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let parsed: unknown;
    try { parsed = JSON.parse(script[1]); } catch { continue; }
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record['@type'] === 'NewsArticle') {
        if (typeof record.datePublished === 'string') dates.push(record.datePublished);
        if (typeof record.dateModified === 'string') dates.push(record.dateModified);
      }
      if (record['@graph']) visit(record['@graph']);
    };
    visit(parsed);
  }
  if (dates.length < 2 || dates.some((value) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return true;
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7));
    return !((year === season && month >= 8) || (year === season + 1 && month <= 2));
  })) invalid('assignment_article_date_mismatch');
}
export function parseSharpFootballAssignments(html: string, season: number, week: number, games: Game[]): ParsedRefereeAssignment[] {
  const eligible = scope(season, week, games);
  sharpSeason(html, season);
  const candidates: Array<Array<[string, string]>> = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((cell) => text(cell[1])));
    if (rows[0]?.length !== 2 || rows[0][0].toLowerCase() !== `week ${week}` || rows[0][1].toLowerCase() !== 'referee') continue;
    if (rows.slice(1).some((row) => row.length !== 2)) invalid('assignment_layout_changed');
    candidates.push(rows.slice(1).map((row) => [row[0], row[1]]));
  }
  if (candidates.length !== 1) invalid('assignment_table_scope_mismatch');
  return matchRows(candidates[0], eligible);
}

export async function fetchRefereeAssignments(season: number, week: number, games: Game[], store: SnapshotStore = new LocalSnapshotStore(path.join(config.dataDir, 'snapshots'), { timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024 })): Promise<{ assignments: FetchedRefereeAssignment[]; snapshots: SourceSnapshot[]; warnings: string[] }> {
  scope(season, week, games);
  const sources = [
    { provider: 'football-zebras' as const, url: assignmentSourceUrls.footballZebras(season, week), extension: 'json' as const },
    { provider: 'sharp-football' as const, url: assignmentSourceUrls.sharpFootball, extension: 'html' as const },
  ];
  const settled = await Promise.allSettled(sources.map(async (source) => {
    const fetched = await store.fetch({ ...source, license: ASSIGNMENT_SOURCE_LICENSE, metadata: { season, week, scope: 'head-referee-assignment' } }, { maxAgeMs: 15 * 60 * 1000 });
    const bytes = await store.read(fetched);
    if (bytes.byteLength > 2 * 1024 * 1024) invalid('source_too_large');
    let parsed: ParsedRefereeAssignment[], articleUrl: string;
    if (source.provider === 'football-zebras') {
      let payload: unknown;
      try { payload = JSON.parse(bytes.toString('utf8')); } catch { invalid('assignment_article_invalid'); }
      parsed = parseFootballZebrasAssignments(payload, season, week, games);
      articleUrl = footballZebrasArticleUrl(payload, season, week);
    } else {
      parsed = parseSharpFootballAssignments(bytes.toString('utf8'), season, week, games);
      articleUrl = source.url;
    }
    const snapshot: SourceSnapshot = { ...fetched, metadata: { ...fetched.metadata, season, week, scope: 'head-referee-assignment', articleUrl } };
    return { snapshot, assignments: parsed.map((assignment) => ({ ...assignment, provider: source.provider, snapshot })) };
  }));
  const assignments: FetchedRefereeAssignment[] = [], snapshots: SourceSnapshot[] = [], warnings: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') { snapshots.push(result.value.snapshot); assignments.push(...result.value.assignments); }
    else warnings.push(`${sources[index].provider}: ${result.reason instanceof SourceError ? result.reason.code : 'assignment_source_unavailable'}`);
  });
  return { assignments, snapshots, warnings };
}
