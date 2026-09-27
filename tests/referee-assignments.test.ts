import { beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Game,SourceSnapshot } from '../packages/core/src/contracts.js';
const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),client:vi.fn(),saveSnapshots:vi.fn(),fetch:vi.fn(),enqueue:vi.fn(),completion:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query,transaction:mocks.transaction}));
vi.mock('../packages/core/src/repository.js',()=>({saveSnapshots:mocks.saveSnapshots}));
vi.mock('../packages/core/src/referee-assignment-sources.js',()=>({fetchRefereeAssignments:mocks.fetch}));
vi.mock('../packages/core/src/jobs.js',()=>({enqueue:mocks.enqueue,enqueueRefereeCompletionIfIdle:mocks.completion}));
import { getCachedRefereeAssignment,refreshRefereeAssignments,resolveRefereeAssignment,scheduleRefereeAssignmentRefresh } from '../packages/core/src/referee-assignments.js';

const game:Game={id:'2026_03_ATL_GB',season:2026,week:3,gameType:'REG',homeTeam:'GB',awayTeam:'ATL',homeScore:null,awayScore:null,kickoffAt:'2026-09-25T00:15:00Z',providerData:{}};
function feed(provider:'football-zebras'|'sharp-football',name='Shawn Smith'){
 const url=provider==='football-zebras'?'https://www.footballzebras.com/wp-json/wp/v2/posts?slug=week-3-referee-assignments-2026&_fields=id,date_gmt,modified_gmt,link,title,content':'https://www.sharpfootballanalysis.com/betting/nfl-referee-assignments-penalty-trends-betting-impact/';
 const articleUrl=provider==='football-zebras'?'https://www.footballzebras.com/2026/09/week-3-referee-assignments-2026/':url;
 const checksum=(provider==='football-zebras'?'a':'b').repeat(64);
 const snapshot:SourceSnapshot={id:createHash('sha256').update(`${url}\n${checksum}`).digest('hex'),provider,url,checksum,metadata:{articleUrl},license:'Public assignment facts; publisher copyright',retrievedAt:'2026-09-22T17:14:21Z',path:'/synthetic'};
 return {provider,assignments:[{gameId:game.id,name}],snapshot};
}
beforeEach(()=>{vi.resetAllMocks();mocks.query.mockResolvedValue({rows:[]});mocks.transaction.mockImplementation(fn=>fn({query:mocks.client}));});
describe('durable pregame referee assignments',()=>{
 it('prefers Football Zebras regardless of row order and records both sources',()=>{
  const resolved=resolveRefereeAssignment(game,[feed('sharp-football'),feed('football-zebras')]);
  expect(resolved.assignment).toMatchObject({gameId:game.id,name:'Shawn Smith',status:'reported'});
  expect(resolved.assignment!.sources.map(source=>source.provider)).toEqual(['football-zebras','sharp-football']);
  expect(resolved.snapshots).toHaveLength(2);
 });
 it('uses Sharp alone as a backup and fails closed on conflicting names',()=>{
  expect(resolveRefereeAssignment(game,[feed('sharp-football')]).assignment?.name).toBe('Shawn Smith');
  expect(resolveRefereeAssignment(game,[feed('football-zebras'),feed('sharp-football','Scott Novak')]).assignment).toMatchObject({name:null,status:'conflict'});
 });
 it('handles known aliases without falsely declaring disagreement',async()=>{
  mocks.query.mockResolvedValue({rows:[feed('football-zebras','Ron Torbert'),feed('sharp-football','Ronald Torbert')]});
  expect((await getCachedRefereeAssignment(game)).assignment).toMatchObject({status:'reported',name:'Ron Torbert'});
  expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('retains verified imported attribution when the cache has never seen that week',async()=>{
  const saved=resolveRefereeAssignment(game,[feed('football-zebras')]);mocks.query.mockResolvedValue({rows:[]});
  expect(await getCachedRefereeAssignment(game,saved)).toEqual(saved);
  expect(await getCachedRefereeAssignment(game,{...saved,snapshots:[]})).toEqual({snapshots:[]});
  const other={...game,id:'2026_03_LAC_BUF',awayTeam:'LAC',homeTeam:'BUF'};
  expect(await getCachedRefereeAssignment(other,saved)).toEqual({snapshots:[]});
  expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('rejects wrong games, invalid sources and duplicate assignment rows',()=>{
  const wrong=feed('football-zebras');wrong.assignments[0].gameId='2026_03_LAC_BUF';
  expect(resolveRefereeAssignment(game,[wrong])).toEqual({snapshots:[]});
  const altered=feed('football-zebras');altered.snapshot.checksum='f'.repeat(64);
  expect(resolveRefereeAssignment(game,[altered])).toEqual({snapshots:[]});
  const duplicate=feed('football-zebras');duplicate.assignments.push({...duplicate.assignments[0]});
  expect(resolveRefereeAssignment(game,[duplicate])).toEqual({snapshots:[]});
 });
 it('continues after a provider outage without replacing any durable assignments',async()=>{
  mocks.query.mockResolvedValue({rows:[{game_json:game}]});mocks.fetch.mockResolvedValue({assignments:[],snapshots:[],warnings:['source_http_503']});
  expect(await refreshRefereeAssignments(2026,3)).toMatchObject({assignments:0,updatedFeeds:0,warnings:['source_http_503']});
  expect(mocks.client).not.toHaveBeenCalled();expect(mocks.completion).not.toHaveBeenCalled();
 });
 it('saves a successful fallback and queues metadata completion for existing reports',async()=>{
  const row=feed('sharp-football');mocks.query.mockResolvedValueOnce({rows:[{game_json:game}]}).mockResolvedValueOnce({rows:[{id:game.id}]});
  mocks.fetch.mockResolvedValue({assignments:[{...row.assignments[0],provider:row.provider,snapshot:row.snapshot}],snapshots:[row.snapshot],warnings:['football-zebras:unavailable']});
  mocks.client.mockResolvedValue({rows:[{snapshot_id:row.snapshot.id}]});
  expect(await refreshRefereeAssignments(2026,3)).toMatchObject({assignments:1,updatedFeeds:1});
  expect(mocks.saveSnapshots).toHaveBeenCalledWith([row.snapshot]);expect(mocks.completion).toHaveBeenCalledWith(game.id,expect.stringContaining('assignment-completion:'));
  expect(mocks.client.mock.calls[0][1]).toEqual([2026,3,'sharp-football',row.snapshot.id,JSON.stringify(row.assignments)]);
 });
 it('prefetches upcoming weeks and retries every 15 minutes independently of analysis',async()=>{
  const now=Date.parse('2026-09-22T12:00:00Z');mocks.query.mockResolvedValue({rows:[{week:3},{week:4}]});
  expect(await scheduleRefereeAssignmentRefresh(2026,now)).toBe(2);
  expect(mocks.query.mock.calls[0][0]).toContain("interval '7 days'");
  expect(mocks.enqueue.mock.calls[0].slice(0,3)).toEqual(['refresh-referees',null,{season:2026,week:3}]);
  const key=mocks.enqueue.mock.calls[0][3];await scheduleRefereeAssignmentRefresh(2026,now+60000);
  expect(mocks.enqueue.mock.calls[2][3]).toBe(key);await scheduleRefereeAssignmentRefresh(2026,now+15*60000);
  expect(mocks.enqueue.mock.calls[4][3]).not.toBe(key);
 });
});
