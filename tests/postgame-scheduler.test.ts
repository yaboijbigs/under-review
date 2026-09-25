import { beforeEach,describe,expect,it,vi } from 'vitest';

const mocks=vi.hoisted(()=>({query:vi.fn(),enqueue:vi.fn(),pending:vi.fn(),enqueueReferee:vi.fn(),pendingReferee:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
vi.mock('../packages/core/src/jobs.js',()=>({enqueueDataCompletionIfIdle:mocks.enqueue,enqueueRefereeCompletionIfIdle:mocks.enqueueReferee}));
vi.mock('../packages/core/src/data-completion.js',()=>({isPendingGameData:mocks.pending}));
vi.mock('../packages/core/src/referee-completion.js',()=>({isPendingRefereeData:mocks.pendingReferee}));
import { schedulePendingGameData } from '../packages/core/src/postgame-scheduler.js';

describe('pending postgame data scheduling',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();
  mocks.pending.mockImplementation(analysis=>analysis.pending===true);
  mocks.pendingReferee.mockImplementation(analysis=>analysis.refereeMissing===true);
  mocks.query.mockResolvedValue({rows:[{id:'awaiting-totals',analysis:{pending:true}},{id:'complete',analysis:{pending:false}}]});
 });
 it('checks incomplete reports again after 15 minutes without waiting for the next six-hour window',async()=>{
  const start=Date.parse('2026-09-25T04:35:00Z');
  expect(await schedulePendingGameData(2026,start)).toBe(1);
  const first=mocks.enqueue.mock.calls[0][1];
  await schedulePendingGameData(2026,start+60000);
  expect(mocks.enqueue.mock.calls[1][1]).toBe(first);
  await schedulePendingGameData(2026,start+15*60000);
  expect(mocks.enqueue.mock.calls[2][1]).not.toBe(first);
  expect(mocks.enqueue.mock.calls.every(([id])=>id==='awaiting-totals')).toBe(true);
 });
 it('does not enqueue data checks for completed ratings',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:'complete',analysis:{pending:false}}]});
  expect(await schedulePendingGameData(2026)).toBe(0);
  expect(mocks.enqueue).not.toHaveBeenCalled();
 });
 it('checks missing referees on rated games every 15 minutes, including older weeks',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:'week-one-rated',analysis:{pending:false,refereeMissing:true}}]});
  const start=Date.parse('2026-09-25T04:35:00Z');
  expect(await schedulePendingGameData(2026,start)).toBe(1);
  const first=mocks.enqueueReferee.mock.calls[0][1];
  await schedulePendingGameData(2026,start+60000);
  expect(mocks.enqueueReferee.mock.calls[1][1]).toBe(first);
  await schedulePendingGameData(2026,start+15*60000);
  expect(mocks.enqueueReferee.mock.calls[2][1]).not.toBe(first);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[0][0]).not.toContain("interval '8 days'");
 });
 it('schedules independent aggregate and referee checks when both are missing',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:'both-missing',analysis:{pending:true,refereeMissing:true}}]});
  expect(await schedulePendingGameData(2026)).toBe(2);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  expect(mocks.enqueueReferee).toHaveBeenCalledTimes(1);
 });
 it('uses the requested season and instant to exclude future games',async()=>{
  const now=Date.parse('2026-09-25T04:35:00Z');
  await schedulePendingGameData(2026,now);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('g.kickoff_at<=$2::timestamptz'),[2026,new Date(now)]);
 });
});
