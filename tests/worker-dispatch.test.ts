import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../packages/core/src/jobs.js';

const mocks = vi.hoisted(() => ({ claimJob: vi.fn(), enqueue: vi.fn(), enqueueAnalysisIfIdle: vi.fn(), heartbeat: vi.fn(), finishJob: vi.fn(), refreshGameAudit: vi.fn(), createDraft: vi.fn(), analyzeGame: vi.fn(), syncSeason: vi.fn(), query: vi.fn(), poolEnd: vi.fn(), recoverUnknownPublications: vi.fn(), repairSourceRegressions: vi.fn(), completePendingGameData:vi.fn(), completePendingRefereeData:vi.fn(), schedulePendingGameData:vi.fn(), publishOutbox:vi.fn() }));
vi.mock('node:fs/promises', () => ({ statfs: vi.fn(async () => ({ bavail: 100000000, bsize: 4096 })) }));
vi.mock('@under-review/core/config', () => ({ config: { dataDir: '/synthetic', season: 2026, staging: true, workerPollMs: 1 }, log: vi.fn() }));
vi.mock('@under-review/core/db', () => ({ query: mocks.query, pool: { end: mocks.poolEnd } }));
vi.mock('@under-review/core/jobs', () => ({ claimJob: mocks.claimJob, enqueue: mocks.enqueue, enqueueAnalysisIfIdle: mocks.enqueueAnalysisIfIdle, heartbeat: mocks.heartbeat, finishJob: mocks.finishJob }));
vi.mock('@under-review/core/pipeline', () => ({ analyzeGame: mocks.analyzeGame, syncSeason: mocks.syncSeason }));
vi.mock('@under-review/core/audit-refresh', () => ({ refreshGameAudit: mocks.refreshGameAudit }));
vi.mock('@under-review/core/repository', () => ({ repairSourceRegressions: mocks.repairSourceRegressions }));
vi.mock('@under-review/core/publishing', () => ({ createDraft: mocks.createDraft, publishOutbox: mocks.publishOutbox, recoverUnknownPublications: mocks.recoverUnknownPublications }));
vi.mock('@under-review/core/data-completion',()=>({completePendingGameData:mocks.completePendingGameData}));
vi.mock('@under-review/core/referee-completion',()=>({completePendingRefereeData:mocks.completePendingRefereeData}));
vi.mock('@under-review/core/postgame-scheduler',()=>({schedulePendingGameData:mocks.schedulePendingGameData}));

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
    mocks.claimJob.mockImplementation(async(_worker,lane)=>lane==='fast'?null:job);
    mocks.schedulePendingGameData.mockResolvedValue(0);
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
    expect(mocks.claimJob.mock.calls.filter(([,lane])=>lane==='analysis')).toHaveLength(1);
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
    mocks.claimJob.mockImplementation(async(_worker,lane)=>lane==='fast'?null:{ ...job,payload:{} });
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

  it('checks pending data and publishes while an unrelated full analysis is still running',async()=>{
    const actions:string[]=[];
    let finishAnalysis!:()=>void;
    const blocked=new Promise<void>(resolve=>{finishAnalysis=resolve;});
    let fastClaims=0;
    mocks.claimJob.mockImplementation(async(_worker,lane)=>lane==='analysis'
      ?{...job,id:'heavy',kind:'analyze',gameId:'older-game',payload:{}}
      :++fastClaims===1?{...job,id:'data',kind:'complete-data',gameId:'new-game',payload:{}}
      :{...job,id:'post',kind:'publish',gameId:'new-game',payload:{outboxId:'approved-post'}});
    mocks.analyzeGame.mockImplementation(async()=>{actions.push('analysis-start');await blocked;actions.push('analysis-finish');});
    mocks.completePendingGameData.mockImplementation(async()=>{actions.push('data-ready');return {gameId:'new-game',status:'updated'};});
    mocks.publishOutbox.mockImplementation(async()=>{actions.push('published');process.emit('SIGTERM');finishAnalysis();});
    await import('../apps/worker/src/index.js');
    expect(actions).toEqual(['analysis-start','data-ready','published','analysis-finish']);
    expect(mocks.schedulePendingGameData).toHaveBeenCalledWith(2026);
    expect(mocks.publishOutbox).toHaveBeenCalledExactlyOnceWith('approved-post');
    expect(mocks.finishJob.mock.calls.map(([value])=>value.id).sort()).toEqual(['data','heavy','post']);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  it('routes changed non-referee game data to normal analysis without running R in the fast lane',async()=>{
    mocks.claimJob.mockImplementation(async(_worker,lane)=>lane==='analysis'?null:{...job,kind:'complete-referee',payload:{}});
    mocks.completePendingRefereeData.mockImplementation(async()=>{process.emit('SIGTERM');return {gameId:'synthetic-game',status:'needs_analysis',revisionId:'old-report'};});
    await import('../apps/worker/src/index.js');
    expect(mocks.completePendingRefereeData).toHaveBeenCalledExactlyOnceWith('synthetic-game');
    expect(mocks.enqueueAnalysisIfIdle).toHaveBeenCalledExactlyOnceWith('synthetic-game',{preferRaw:false},'referee-reconcile:synthetic-game:old-report:synthetic-job');
    expect(mocks.analyzeGame).not.toHaveBeenCalled();
    expect(mocks.publishOutbox).not.toHaveBeenCalled();
  });

  it('finishes a still-waiting data check without running R or preparing a premature post',async()=>{
    mocks.claimJob.mockImplementation(async(_worker,lane)=>lane==='analysis'?null:{...job,kind:'complete-data',payload:{}});
    mocks.completePendingGameData.mockImplementation(async()=>{process.emit('SIGTERM');return {gameId:'synthetic-game',status:'waiting'};});
    await import('../apps/worker/src/index.js');
    expect(mocks.completePendingGameData).toHaveBeenCalledExactlyOnceWith('synthetic-game');
    expect(mocks.analyzeGame).not.toHaveBeenCalled();
    expect(mocks.publishOutbox).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.finishJob.mock.calls[0]).toHaveLength(1);
  });
});
