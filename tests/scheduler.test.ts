import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../packages/core/src/contracts.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), syncSchedule: vi.fn(), saveGames: vi.fn(), saveSnapshots: vi.fn(), enqueue: vi.fn(), enqueueAnalysisIfIdle: vi.fn() }));
vi.mock('../packages/core/src/db.js', () => ({ query: mocks.query }));
vi.mock('../packages/core/src/ingest.js', () => ({ LocalSnapshotStore: class {}, syncSchedule: mocks.syncSchedule, ingestGame: vi.fn() }));
vi.mock('../packages/core/src/repository.js', () => ({ saveGames: mocks.saveGames, saveSnapshots: mocks.saveSnapshots, saveAnalysis: vi.fn(), getGame: vi.fn() }));
vi.mock('../packages/core/src/jobs.js', () => ({ enqueue: mocks.enqueue, enqueueAnalysisIfIdle: mocks.enqueueAnalysisIfIdle }));
vi.mock('../packages/core/src/publishing.js', () => ({ maybeAutomaticDraft: vi.fn() }));
import { syncSeason } from '../packages/core/src/pipeline.js';

const fixed = new Date('2026-09-22T03:00:00.000Z');
function game(id: string, hoursAgo: number, patch: Partial<Game> = {}): Game {
  return { id, season: 2026, week: 2, gameType: 'REG', homeTeam: 'HOME', awayTeam: 'AWAY', homeScore: 0, awayScore: 20, kickoffAt: new Date(fixed.getTime() - hoursAgo * 3600000).toISOString(), providerData: {}, ...patch };
}

describe('season scheduling window', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(fixed.getTime());
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.syncSchedule.mockResolvedValue({ games: [], snapshots: [] });
  });

  it('uses coalescing for completed initial and clean reconciliation jobs inside the normal window', async () => {
    mocks.syncSchedule.mockResolvedValue({ games: [game('new', 4), game('existing', 48), game('old', 8 * 24 + 1), game('future', -1), game('not-final', 4, { awayScore: null })], snapshots: [] });
    mocks.query.mockImplementation(async (_sql, [id]) => ({ rows: id === 'existing' ? [{ created_at: new Date() }] : [] }));
    await syncSeason(2026);
    expect(mocks.enqueueAnalysisIfIdle).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueAnalysisIfIdle).toHaveBeenNthCalledWith(1, 'new', { backfill: false, preferRaw: true }, expect.stringMatching(/^scheduled-analysis:new:initial:/));
    expect(mocks.enqueueAnalysisIfIdle).toHaveBeenNthCalledWith(2, 'existing', { backfill: false, preferRaw: false }, expect.stringMatching(/^scheduled-analysis:existing:reconcile:/));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.saveGames).toHaveBeenCalledTimes(5);
  });

  it('syncs metadata without scheduling when explicitly disabled', async () => {
    mocks.syncSchedule.mockResolvedValue({ games: [game('new', 4)], snapshots: [] });
    expect(await syncSeason(2026, false)).toEqual({ games: 1, snapshots: [] });
    expect(mocks.enqueueAnalysisIfIdle).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
