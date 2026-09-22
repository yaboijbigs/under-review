import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../packages/core/src/jobs.js';

const mocks = vi.hoisted(() => ({ claimJob: vi.fn(), enqueue: vi.fn(), enqueueAnalysisIfIdle: vi.fn(), heartbeat: vi.fn(), finishJob: vi.fn(), refreshGameAudit: vi.fn(), createDraft: vi.fn(), analyzeGame: vi.fn(), syncSeason: vi.fn(), query: vi.fn(), poolEnd: vi.fn(), recoverUnknownPublications: vi.fn(), repairSourceRegressions: vi.fn() }));
vi.mock('node:fs/promises', () => ({ statfs: vi.fn(async () => ({ bavail: 100000000, bsize: 4096 })) }));
vi.mock('@under-review/core/config', () => ({ config: { dataDir: '/synthetic', season: 2026, staging: true, workerPollMs: 1 }, log: vi.fn() }));
vi.mock('@under-review/core/db', () => ({ query: mocks.query, pool: { end: mocks.poolEnd } }));
vi.mock('@under-review/core/jobs', () => ({ claimJob: mocks.claimJob, enqueue: mocks.enqueue, enqueueAnalysisIfIdle: mocks.enqueueAnalysisIfIdle, heartbeat: mocks.heartbeat, finishJob: mocks.finishJob }));
vi.mock('@under-review/core/pipeline', () => ({ analyzeGame: mocks.analyzeGame, syncSeason: mocks.syncSeason }));
vi.mock('@under-review/core/audit-refresh', () => ({ refreshGameAudit: mocks.refreshGameAudit }));
vi.mock('@under-review/core/repository', () => ({ repairSourceRegressions: mocks.repairSourceRegressions }));
vi.mock('@under-review/core/publishing', () => ({ createDraft: mocks.createDraft, publishOutbox: vi.fn(), recoverUnknownPublications: mocks.recoverUnknownPublications }));

const job: Job = { id: 'synthetic-job', kind: 'refresh-audit', gameId: 'synthetic-game', payload: { prepareDraft: true }, attempts: 1, maxAttempts: 5, workerId: 'synthetic-worker' };
let previousTerm: ReturnType<typeof process.listeners>;
let previousInt: ReturnType<typeof process.listeners>;

describe('single-worker audit refresh dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    previousTerm = process.listeners('SIGTERM');
    previousInt = process.listeners('SIGINT');
    mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
    mocks.repairSourceRegressions.mockResolvedValue([]);
    mocks.claimJob.mockResolvedValue(job);
    mocks.refreshGameAudit.mockImplementation(async () => { process.emit('SIGTERM'); });
  });
  afterEach(() => {
    for (const listener of process.listeners('SIGTERM')) if (!previousTerm.includes(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT')) if (!previousInt.includes(listener)) process.removeListener('SIGINT', listener);
  });

  it('awaits refresh before creating its requested draft and finishing the job', async () => {
    const actions: string[] = [];
    mocks.refreshGameAudit.mockImplementation(async () => { actions.push('refresh'); process.emit('SIGTERM'); });
    mocks.createDraft.mockImplementation(async () => { actions.push('draft'); });
    mocks.finishJob.mockImplementation(async () => { actions.push('finish'); });
    await import('../apps/worker/src/index.js');
    expect(actions).toEqual(['refresh', 'draft', 'finish']);
    expect(mocks.refreshGameAudit).toHaveBeenCalledExactlyOnceWith('synthetic-game');
    expect(mocks.createDraft).toHaveBeenCalledExactlyOnceWith('synthetic-game');
    expect(mocks.finishJob).toHaveBeenCalledExactlyOnceWith(job);
    expect(mocks.claimJob).toHaveBeenCalledTimes(1);
    expect(mocks.analyzeGame).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  it('records a refresh failure through finishJob without drafting or reporting success', async () => {
    const error = new Error('Synthetic stale input');
    mocks.refreshGameAudit.mockImplementation(async () => { process.emit('SIGTERM'); throw error; });
    await import('../apps/worker/src/index.js');
    expect(mocks.finishJob).toHaveBeenCalledExactlyOnceWith(job, error);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('does not create a draft unless that refresh explicitly requests one', async () => {
    mocks.claimJob.mockResolvedValue({ ...job, payload: {} });
    await import('../apps/worker/src/index.js');
    expect(mocks.refreshGameAudit).toHaveBeenCalledExactlyOnceWith('synthetic-game');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('reconciles with clean data when an audit refresh would repeat a source downgrade', async () => {
    const actions:string[]=[];
    mocks.refreshGameAudit.mockImplementation(async()=>{actions.push('refresh');throw Object.assign(new Error('Use clean source'),{code:'source_downgrade'});});
    mocks.analyzeGame.mockImplementation(async()=>{actions.push('clean');process.emit('SIGTERM');});
    mocks.createDraft.mockImplementation(async()=>{actions.push('draft');});
    mocks.finishJob.mockImplementation(async()=>{actions.push('finish');});
    await import('../apps/worker/src/index.js');
    expect(actions).toEqual(['refresh','clean','draft','finish']);
    expect(mocks.analyzeGame).toHaveBeenCalledExactlyOnceWith('synthetic-game',{preferRaw:false,backfill:false});
    expect(mocks.finishJob).toHaveBeenCalledExactlyOnceWith(job);
  });

  it('keeps failed clean reconciliation retryable and does not create a draft', async () => {
    const error=new Error('Clean source temporarily unavailable');
    mocks.refreshGameAudit.mockRejectedValue(Object.assign(new Error('Use clean source'),{code:'source_downgrade'}));
    mocks.analyzeGame.mockImplementation(async()=>{process.emit('SIGTERM');throw error;});
    await import('../apps/worker/src/index.js');
    expect(mocks.finishJob).toHaveBeenCalledExactlyOnceWith(job,error);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('repairs equivalent legacy regressions at startup and queues clean reconciliation for actual changes', async () => {
    mocks.repairSourceRegressions.mockResolvedValue([
      { gameId: 'restored', revisionId: 'restored-id', status: 'restored' },
      { gameId: 'changed', revisionId: 'raw-id', status: 'reconcile', reason: 'Findings changed' },
    ]);
    await import('../apps/worker/src/index.js');
    expect(mocks.repairSourceRegressions).toHaveBeenCalledExactlyOnceWith(2026);
    expect(mocks.enqueueAnalysisIfIdle).toHaveBeenCalledExactlyOnceWith('changed', { preferRaw: false }, 'source-repair:changed:raw-id');
  });
});
