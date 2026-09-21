import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestGame, syncSchedule } from '../packages/core/src/ingest.js';
import { FTN_FIELDS, joinCharting, kickoffUtc, normalizePlays, normalizeSchedule, parseCsv, validateGameData } from '../packages/core/src/normalize.js';
import { SourceError, type SnapshotStore, type SourceRequest, type SourceSnapshot } from '../packages/core/src/sources.js';

const fixtureRoot = path.resolve('tests/fixtures/real');
const fixture = (name: string): Promise<Buffer> => readFile(path.join(fixtureRoot, name));
async function sample(id = '2023_01_DET_KC') {
  const game = parseCsv(await fixture('schedules.csv')).map(normalizeSchedule).find((value) => value.id === id)!;
  const plays = normalizePlays(parseCsv(await fixture(`${id}.pbp.csv`)), id);
  return { game, plays };
}

class FixtureStore implements SnapshotStore {
  requests: string[] = [];
  constructor(private readonly id: string, private readonly missingFtn = false) {}
  async fetch(request: SourceRequest): Promise<SourceSnapshot> {
    this.requests.push(request.url);
    if (request.extension === 'rds') throw new SourceError('source_http_404', 'Raw source not yet published.', true);
    if (request.provider === 'ftn-via-nflverse' && this.missingFtn) throw new SourceError('source_http_404', 'Charting unavailable.', true);
    const filename = request.provider === 'nflverse-schedules' ? 'schedules.csv' : request.provider === 'ftn-via-nflverse' ? `${this.id}.ftn_charting.csv` : `${this.id}.pbp.csv`;
    return { id: filename, provider: request.provider, url: request.url, retrievedAt: '2026-09-21T00:00:00.000Z', checksum: 'fixture', path: path.join(fixtureRoot, filename), license: request.license, metadata: {} };
  }
  read(snapshot: SourceSnapshot) { return readFile(snapshot.path); }
}

describe('real attributable nflverse ingestion', () => {
  it.each(['2023_01_DET_KC', '2026_01_NE_SEA'])('reconciles completed game %s from authentic source rows', async (id) => {
    const { game, plays } = await sample(id);
    expect(validateGameData(game, plays)).toEqual({ valid: true, issues: [] });
    expect(plays.at(-1)?.desc).toBe('END GAME');
    expect(plays.at(-1)?.total_home_score).toBe(game.homeScore);
    expect(plays.at(-1)?.total_away_score).toBe(game.awayScore);
    expect(plays.some((row, index) => index > 0 && Number(row.play_id) < Number(plays[index - 1].play_id))).toBe(true);
    expect(plays.map((row) => row.source_order)).toEqual(plays.map((_, index) => index));
  });

  it('verifies checked-in fixture checksums and separate FTN licensing', async () => {
    const manifest = JSON.parse((await fixture('manifest.json')).toString()) as { file: string; checksum: string; license: string }[];
    for (const item of manifest) {
      expect(createHash('sha256').update(await fixture(item.file)).digest('hex')).toBe(item.checksum);
      if (item.file.includes('ftn_charting')) expect(item.license).toBe('CC-BY-SA-4.0');
    }
  });

  it('uses provider seasons and accepts only regular/postseason schedule game types', async () => {
    const result = await syncSchedule(2023, new FixtureStore('2023_01_DET_KC'));
    expect(result.games.map((game) => game.id)).toEqual(['2023_01_DET_KC']);
    expect(result.games[0].season).toBe(2023);
    expect(result.games[0].kickoffAt).toBe('2023-09-08T00:20:00.000Z');
  });

  it('falls back from unavailable raw PBP and keeps absent charting unavailable', async () => {
    const { game } = await sample();
    const result = await ingestGame(game, new FixtureStore(game.id, true));
    expect(result.validation.valid).toBe(true);
    expect(result.sourceKind).toBe('clean');
    expect(result.ftn).toEqual([]);
    expect(result.chartingCoverage.status).toBe('unavailable');
    expect(result.chartingCoverage.fields.is_drop.observed).toBe(0);
    expect(result.warnings).toHaveLength(2);
  });

  it('joins verified FTN game/play keys without treating every row as full coverage', async () => {
    const { game, plays } = await sample();
    const ftn = parseCsv(await fixture(`${game.id}.ftn_charting.csv`));
    const joined = joinCharting(game.id, plays, ftn);
    expect(joined.coverage.joined).toBeGreaterThan(0);
    expect(joined.rows.every((row) => row.nflverse_game_id === game.id)).toBe(true);
    expect(joined.coverage.fields.is_drop.positive).toBeGreaterThan(0);
    expect(joined.coverage.fields.is_drop.observed).toBeGreaterThan(0);
  });
});

describe('conservative finality and incomplete-data gates', () => {
  it('rejects scores without an explicit terminal provider record', async () => {
    const { game, plays } = await sample();
    expect(validateGameData(game, plays.slice(0, -1)).issues).toContain('explicit_game_end_missing');
  });
  it('rejects contradictory final scores, duplicate IDs, missing quarters and identities', async () => {
    const { game, plays } = await sample();
    expect(validateGameData({ ...game, homeScore: 19 }, plays).issues).toContain('final_score_mismatch');
    expect(validateGameData(game, [plays[0], ...plays]).issues).toContain('play_id_duplicate');
    expect(validateGameData(game, plays.filter((row) => row.qtr !== 2)).issues).toContain('quarters_incomplete');
    expect(validateGameData(game, plays.map((row, index) => index === 2 ? { ...row, posteam: 'INVALID' } : row)).issues).toContain('possession_team_invalid');
    expect(validateGameData(game, plays.filter((row) => row.play_id !== 621)).issues).toContain('scoring_sequence_incomplete_or_unsupported');
  });
  it('does not reject a tied final score merely because neither team won', async () => {
    const { game, plays } = await sample();
    const tied = { ...game, homeScore: 20, awayScore: 20, providerData: { ...game.providerData, result: 0 } };
    const rows = plays.map((row, index) => index === plays.length - 1 ? { ...row, total_away_score: 20 } : row);
    expect(validateGameData(tied, rows).issues).not.toContain('final_score_mismatch');
  });
  it('preserves false vs missing FTN fields and quarantines conflicting duplicates', async () => {
    const { game, plays } = await sample();
    const passing = plays.find((play) => play.pass_attempt === 1 && play.sack !== 1)!;
    const base = { nflverse_game_id: game.id, nflverse_play_id: passing.play_id, is_drop: false, is_interception_worthy: null };
    const one = joinCharting(game.id, plays, [base]);
    expect(one.rows[0].is_drop).toBe(false);
    expect(one.rows[0].is_interception_worthy).toBe(null);
    expect(one.coverage.fields.is_drop.observed).toBe(1);
    expect(one.coverage.fields.is_interception_worthy.observed).toBe(0);
    expect(one.coverage.status).toBe('partial');
    expect(FTN_FIELDS.every((field) => field in one.rows[0])).toBe(true);
    const conflict = joinCharting(game.id, plays, [base, { ...base, is_drop: true }]);
    expect(conflict.rows).toEqual([]);
    expect(conflict.issues).toContain('ftn_conflicting_keys');
  });
  it('handles Eastern kickoff daylight saving and January correctly', () => {
    expect(kickoffUtc('2026-01-18', '18:30')).toBe('2026-01-18T23:30:00.000Z');
    expect(kickoffUtc('2026-09-13', '13:00')).toBe('2026-09-13T17:00:00.000Z');
    expect(kickoffUtc('2026-09-13', null)).toBeNull();
  });
  it('parses quoted CSV descriptions and missing numeric values without changing identifiers', () => {
    const rows = parseCsv('game_id,old_game_id,play_id,desc,epa,is_drop\n2023_01_DET_KC,2023090700,41,"run, stopped",,FALSE\n');
    expect(rows[0]).toMatchObject({ game_id: '2023_01_DET_KC', old_game_id: '2023090700', play_id: 41, desc: 'run, stopped', epa: null, is_drop: false });
  });
});
