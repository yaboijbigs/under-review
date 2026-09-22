import { beforeEach,describe,expect,it,vi } from 'vitest';

const mocks=vi.hoisted(()=>({query:vi.fn(),syncSchedule:vi.fn(),ingestGame:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
vi.mock('../packages/core/src/ingest.js',()=>({LocalSnapshotStore:class {},syncSchedule:mocks.syncSchedule,ingestGame:mocks.ingestGame}));
vi.mock('../packages/core/src/repository.js',()=>({getGame:vi.fn(),saveGames:vi.fn(),saveSnapshots:vi.fn(),saveAnalysis:vi.fn()}));
vi.mock('../packages/core/src/jobs.js',()=>({enqueue:vi.fn(),enqueueAnalysisIfIdle:vi.fn()}));
vi.mock('../packages/core/src/publishing.js',()=>({maybeAutomaticDraft:vi.fn()}));
import { analyzeGame } from '../packages/core/src/pipeline.js';

describe('analysis dispatch rechecks current reports instead of trusting an old job payload',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();
  mocks.syncSchedule.mockResolvedValue({games:[{id:'2026_02_GB_NYJ'}],snapshots:[]});
  // Stop immediately after ingestion: these tests inspect dispatch, never run R.
  mocks.ingestGame.mockResolvedValue({snapshots:[],validation:{valid:false,issues:['synthetic-stop']}});
 });
 it('forces a stale queued raw job to clean reconciliation when any report now exists',async()=>{
  mocks.query.mockResolvedValue({rowCount:1,rows:[{}]});
  await expect(analyzeGame('2026_02_GB_NYJ',{preferRaw:true})).rejects.toThrow('synthetic-stop');
  expect(mocks.ingestGame).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({preferRaw:false}));
 });
 it('allows raw data for the first report only',async()=>{
  mocks.query.mockResolvedValue({rowCount:0,rows:[]});
  await expect(analyzeGame('2026_02_GB_NYJ',{preferRaw:true})).rejects.toThrow('synthetic-stop');
  expect(mocks.ingestGame).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({preferRaw:true}));
 });
 it('honors explicit clean initial analysis',async()=>{
  mocks.query.mockResolvedValue({rowCount:0,rows:[]});
  await expect(analyzeGame('2026_02_GB_NYJ',{preferRaw:false})).rejects.toThrow('synthetic-stop');
  expect(mocks.ingestGame).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({preferRaw:false}));
 });
});
