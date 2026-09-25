import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AnalysisResult,GameReport,SourceSnapshot } from '../packages/core/src/contracts.js';
import { config,projectRoot } from '../packages/core/src/config.js';
import { normalizePlays,normalizeSchedule,parseCsv,type ProviderRow } from '../packages/core/src/normalize.js';
import { LocalSnapshotStore,SourceError,sourceUrls } from '../packages/core/src/sources.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { loadGameProfileReference,normalizeGameProfiles } from '../packages/core/src/game-profile-source.js';
import { applySpreadAudit,loadSpreadReference } from '../packages/core/src/spread.js';
import { loadExpectationsReference } from '../packages/core/src/expectations.js';
import { applyExpectationsAudit } from '../packages/core/src/expectations-integration.js';
import { getGameVerdict } from '../packages/core/src/consumer-summary.js';

const mocks=vi.hoisted(()=>({query:vi.fn(),getReport:vi.fn(),saveAnalysis:vi.fn(),publish:vi.fn(),runAnalytics:vi.fn(),runRRequest:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
vi.mock('../packages/core/src/repository.js',()=>({getReport:mocks.getReport,saveAnalysis:mocks.saveAnalysis,
 stableJson:(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item),
 RevisionConflictError:class extends Error {readonly code='revision_conflict';}
}));
vi.mock('../packages/core/src/publishing.js',()=>({maybeAutomaticDraft:mocks.publish}));
vi.mock('../packages/core/src/analytics-bridge.js',()=>({runAnalytics:mocks.runAnalytics,runRRequest:mocks.runRRequest}));
import { RevisionConflictError } from '../packages/core/src/repository.js';
import { completePendingGameData,DataCompletionError,isPendingGameData } from '../packages/core/src/data-completion.js';

const game=normalizeSchedule({game_id:'2026_03_ATL_GB',season:2026,week:3,game_type:'REG',away_team:'ATL',home_team:'GB',home_score:3,away_score:0,gameday:'2026-09-24',gametime:'20:15',result:3,spread_line:3.5});
const initialPlays:ProviderRow[]=Array.from({length:5},(_,index)=>({game_id:game.id,home_team:game.homeTeam,away_team:game.awayTeam,season:game.season,play_id:index,qtr:Math.max(1,index),total_home_score:index>=3?3:0,total_away_score:0,desc:index===0?'GAME':index===4?'END GAME':'Synthetic test play',play_type:index===1||index===2?'run':index===3?'field_goal':'no_play',posteam:index===1?game.awayTeam:game.homeTeam,defteam:index===1?game.homeTeam:game.awayTeam,yards_gained:index===1?100:index===2?120:0,field_goal_result:index===3?'made':null}));
const aggregateRows:ProviderRow[]=[game.awayTeam,game.homeTeam].map(team=>({game_id:game.id,season:game.season,week:game.week,team,opponent_team:team===game.homeTeam?game.awayTeam:game.homeTeam,passing_yards:0,rushing_yards:team===game.homeTeam?120:100,sack_yards_lost:0,passing_interceptions:0,fumbles_lost_total:0,penalties:3,penalty_yards:20,passing_tds:0,rushing_tds:0,def_tds:0,special_teams_tds:0,fumble_recovery_tds:0,fg_made:team===game.homeTeam?1:0,pat_made:0,passing_2pt_conversions:0,rushing_2pt_conversions:0,def_2pt_made:0,def_safeties:0}));
function csv(rows:ProviderRow[]):Buffer {
 const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))];
 const cell=(value:unknown)=>value===null||value===undefined?'':`"${String(value).replaceAll('"','""')}"`;
 return Buffer.from([fields.join(','),...rows.map(row=>fields.map(field=>cell(row[field])).join(','))].join('\n'));
}
const rAnalysis:AnalysisResult={schemaVersion:1,metrics:[{id:'saved-r-value',category:'coaching',name:'Saved R result',team:'GB',value:0.023,unit:'wp_delta',status:'supported',eventIds:[],playIds:['2'],assumptions:['Synthetic fixture'],modelVersion:'original-r-model',coverage:{eligible:1,modeled:1}}],events:[],timeline:[{playId:'2',quarter:2,clock:'12:00',homeWp:0.6,description:'Synthetic test play'}],coverage:[{category:'coaching',status:'available',eligible:1,modeled:1}],models:[{id:'R-kernel',version:'original-r-model',checksum:'a'.repeat(64),provenance:{original:true}}],warnings:['Original R warning','team_stats_incomplete: Game-profile comparison awaits paired team statistics; play review remains available.']};
let report:GameReport,plays:ProviderRow[],directory:string,aggregate:SourceSnapshot,pbp:SourceSnapshot;
let fetchSource:ReturnType<typeof vi.spyOn>;
const originalDataDir=config.dataDir;
async function persist(provider:string,url:string,bytes:Buffer,extension:'csv'|'rds'='csv'):Promise<SourceSnapshot>{
 const checksum=createHash('sha256').update(bytes).digest('hex');
 const folder=path.join(directory,'snapshots','snapshots');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,`${checksum}.${extension}`),bytes);
 return {id:createHash('sha256').update(`${url}\n${checksum}`).digest('hex'),provider,url,checksum,path:'/untrusted-other-host/legacy-path',license:'Synthetic test data',retrievedAt:'2026-09-25T00:00:00Z',metadata:{test:true}};
}
const dbRows=()=>plays.map((data,provider_order)=>({data:structuredClone(data),snapshot_id:pbp.id,play_id:String(data.play_id),provider_order}));
async function setAggregate(rows:ProviderRow[]){aggregate=await persist('nflverse-team-stats',`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`,csv(rows));aggregate.path=path.join(directory,'snapshots','snapshots',`${aggregate.checksum}.csv`);}
async function setPbp(kind:'raw'|'clean',rows=initialPlays){
 plays=normalizePlays(parseCsv(csv(rows)),game.id);
 pbp=await persist(kind==='raw'?'nflverse-raw-pbp':'nflverse-pbp',kind==='raw'?sourceUrls.raw(game.id):sourceUrls.clean(game.season),kind==='raw'?Buffer.from('Synthetic opaque raw bytes; no R decoding is performed'):csv(rows),kind==='raw'?'rds':'csv');
 if(report)report.revision.sourceSnapshots=report.revision.sourceSnapshots.filter(source=>!['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider)).concat(pbp);
}
async function setCleanSourceBytes(bytes:Buffer){
 pbp=await persist('nflverse-pbp',sourceUrls.clean(game.season),bytes);
 report.revision.sourceSnapshots=report.revision.sourceSnapshots.filter(source=>!['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider)).concat(pbp);
}
async function completedAnalysis():Promise<AnalysisResult>{
 const historical=await loadGameProfileReference(path.join(projectRoot,'analytics/models/game-profiles.json'));
 let result=structuredClone(rAnalysis);
 result.gameAudit=buildGameAudit({game,plays,profiles:normalizeGameProfiles(game,aggregateRows),reference:historical.reference,referenceChecksum:historical.checksum,events:result.events});
 result=applySpreadAudit(game,result,report.revision.sourceSnapshots,await loadSpreadReference());
 return applyExpectationsAudit(game,result,await loadExpectationsReference());
}
beforeEach(async()=>{
 vi.clearAllMocks();directory=await mkdtemp(path.join(os.tmpdir(),'under-review-completion-'));config.dataDir=directory;
 const schedule=await persist('nflverse-schedules',sourceUrls.schedules,csv([game.providerData]));
 await setPbp('clean');await setAggregate(aggregateRows);
 const oldAggregate=await persist('nflverse-team-stats',aggregate.url,csv(aggregateRows.map(row=>({...row,game_id:'2026_02_ATL_GB'}))));
 const ftn=await persist('ftn-via-nflverse',sourceUrls.ftn(game.season),Buffer.from('unchanged optional charting source'));
 const analysis=structuredClone(rAnalysis);analysis.gameAudit={...buildGameAudit({game,plays,profiles:[],events:analysis.events}),version:'under-review-game-audit-v5'};
 report={game:structuredClone(game),revision:{id:'original-revision',number:1,createdAt:'2026-09-25T00:00:00Z',statisticalStatus:'preliminary',chartingStatus:'unavailable',reviewStatus:'not_reviewed',changeSummary:'Synthetic',inputHash:'original',summary:'Synthetic',analysis,sourceSnapshots:[schedule,pbp,ftn,oldAggregate]},history:[],reviews:[],drafts:[]};
 mocks.getReport.mockImplementation(async()=>structuredClone(report));mocks.query.mockImplementation(async()=>({rows:dbRows()}));
 mocks.saveAnalysis.mockResolvedValue({id:'completed-revision',number:2,created:true});mocks.publish.mockResolvedValue(undefined);
 fetchSource=vi.spyOn(LocalSnapshotStore.prototype,'fetch').mockImplementation(async source=>{if(source.provider!=='nflverse-team-stats')throw new Error('Only aggregate fetching is allowed');return aggregate;});
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Unexpected network request')));
});
afterEach(async()=>{config.dataDir=originalDataDir;vi.restoreAllMocks();vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});

describe('missing aggregate completion',()=>{
 it.each(['source_http_404','source_http_503','source_network_error'])('retries an initial aggregate fetch failure and removes only its resolved warning (%s)',async code=>{
  const unrelated=`${code}: Charting unavailable`;
  report.revision.analysis.warnings=[unrelated,`${code}: Game-profile comparison awaits paired team statistics; play review remains available.`];
  expect(isPendingGameData(report.revision.analysis)).toBe(true);
  expect(await completePendingGameData(game.id)).toMatchObject({status:'updated'});
  expect(mocks.saveAnalysis.mock.calls[0][3].warnings).toEqual([unrelated]);
  report.revision.analysis.warnings=[unrelated];
  expect(isPendingGameData(report.revision.analysis)).toBe(false);
 });
 it.each(['team_stats_incomplete','team_stats_unavailable','team_stats_score_mismatch','team_profile_fields_missing'])('identifies only incomplete Unrated aggregate candidates (%s)',async warning=>{
  report.revision.analysis.warnings=[`${warning}: Missing aggregate evidence`];expect(isPendingGameData(report.revision.analysis)).toBe(true);
  report.revision.analysis.warnings=['game_profile_reference_unavailable: No historical reference'];expect(isPendingGameData(report.revision.analysis)).toBe(false);
  report.revision.analysis=await completedAnalysis();expect(getGameVerdict(report.revision.analysis.gameAudit).rating).not.toBeNull();expect(isPendingGameData(report.revision.analysis)).toBe(false);
  // Complete profiles with invalid model evidence also require another path.
  delete report.revision.analysis.gameAudit!.expectations;expect(isPendingGameData(report.revision.analysis)).toBe(false);
 });
 it.each(['clean','raw'] as const)('completes from %s PBP without changing any R evidence or unrelated source',async kind=>{
  await setPbp(kind);const original=structuredClone(report);
  const result=await completePendingGameData(game.id);expect(result).toMatchObject({status:'updated',revisionId:'completed-revision',revisionNumber:2});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);const [savedGame,savedPlays,sources,analysis,sourceKind,guard]=mocks.saveAnalysis.mock.calls[0];
  expect(savedGame).toEqual(game);expect(savedPlays).toEqual(plays);expect(sourceKind).toBe(kind);expect(guard).toEqual({expectedBaseRevisionId:original.revision.id});
  for(const field of ['metrics','events','timeline','coverage'] as const)expect(analysis[field]).toEqual(original.revision.analysis[field]);
  expect(analysis.models.filter((model:{id:string})=>model.id==='R-kernel')).toEqual(rAnalysis.models);
  expect(sources.filter((source:SourceSnapshot)=>source.provider!=='nflverse-team-stats')).toEqual(original.revision.sourceSnapshots.filter(source=>source.provider!=='nflverse-team-stats'));
  expect(sources.filter((source:SourceSnapshot)=>source.provider==='nflverse-team-stats')).toEqual([aggregate]);
  expect(Object.fromEntries(analysis.gameAudit.profiles.map((profile:{team:string;totalYards:number})=>[profile.team,profile.totalYards]))).toEqual({ATL:100,GB:120});expect(getGameVerdict(analysis.gameAudit).rating).not.toBeNull();
  expect(analysis.gameAudit.version).toBe('under-review-game-audit-v5');expect(analysis.warnings).toEqual(['Original R warning']);expect(report).toEqual(original);
  expect(fetchSource).toHaveBeenCalledTimes(1);expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(game.id);expect(mocks.runAnalytics).not.toHaveBeenCalled();expect(mocks.runRRequest).not.toHaveBeenCalled();
 });
 it('waits without creating revisions or publishing when the paired rows are still absent',async()=>{
  await setAggregate(aggregateRows.slice(0,1));
  const reads=vi.spyOn(LocalSnapshotStore.prototype,'read');
  for(let i=0;i<2;i++)expect(await completePendingGameData(game.id)).toMatchObject({status:'waiting',reasonCode:'team_stats_incomplete'});
  expect(reads.mock.calls.some(([source])=>['nflverse-pbp','nflverse-raw-pbp'].includes(source.provider))).toBe(false);
  expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.runAnalytics).not.toHaveBeenCalled();
 });
 it('waits on transient provider failures while retaining the prior report',async()=>{
  fetchSource.mockRejectedValue(new SourceError('source_http_503','Provider unavailable',true));const original=structuredClone(report);
  expect(await completePendingGameData(game.id)).toMatchObject({status:'waiting',reasonCode:'source_http_503'});expect(report).toEqual(original);expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it.each([['score','fg_made',0,'team_stats_score_mismatch'],['yards','rushing_yards',121,'team_stats_yards_mismatch'],['missing count','penalties',null,'team_profile_fields_missing']] as const)('keeps the original report when new aggregate %s fails the existing gate',async(_name,field,value,reasonCode)=>{
  await setAggregate(aggregateRows.map(row=>row.team===game.homeTeam?{...row,[field]:value}:row));
  expect(await completePendingGameData(game.id)).toMatchObject({status:'waiting',reasonCode});expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('rejects a changed schedule instead of moving the saved final score or betting line',async()=>{
  report.game.providerData.spread_line=7;
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_schedule_mismatch'});expect(fetchSource).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('identifies malformed saved source content as requiring normal analysis',async()=>{
  const malformed=await persist('nflverse-schedules',sourceUrls.schedules,Buffer.from('<html>Not CSV</html>'));
  report.revision.sourceSnapshots=report.revision.sourceSnapshots.map(source=>source.provider==='nflverse-schedules'?malformed:source);
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_stored_source_invalid'});expect(fetchSource).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it.each(['snapshot','order','play'] as const)('rejects mismatched stored %s identity before fetching data',async kind=>{
  const rows=dbRows();if(kind==='snapshot')rows[0].snapshot_id='wrong';if(kind==='order')rows[0].provider_order=5;if(kind==='play')rows[0].play_id='999';mocks.query.mockResolvedValue({rows});
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_pbp_snapshot_mismatch'});expect(fetchSource).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('requires clean stored plays to reproduce their source bytes',async()=>{
  const rows=dbRows();rows[1].data.yards_gained=99;mocks.query.mockResolvedValue({rows});
  // Match the aggregate to the altered database row: only immutable-source
  // verification can catch this tampering after the aggregate gate passes.
  await setAggregate(aggregateRows.map(row=>row.team===game.awayTeam?{...row,rushing_yards:99}:row));
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_pbp_snapshot_mismatch'});expect(fetchSource).toHaveBeenCalledTimes(1);expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('streams a multi-game BOM CSV with the target late in the file and compares only its exact rows',async()=>{
  const target=initialPlays.map((row,index)=>index===1?{...row,desc:'Synthetic quoted, description\nwith "a second line"'}:row);
  await setPbp('clean',target);
  const other=Array.from({length:1500},(_,play_id)=>({...initialPlays[1],game_id:'2026_01_LA_SF',play_id,desc:'Other game, quoted\n"description"'}));
  await setCleanSourceBytes(Buffer.concat([Buffer.from('\ufeff'),csv([...other,...target,...other])]));
  let ticks=0;const timer=setInterval(()=>{ticks++;},1);
  try{
  expect(await completePendingGameData(game.id)).toMatchObject({status:'updated'});
  }finally{clearInterval(timer);}
  expect(ticks).toBeGreaterThan(0);
  expect(mocks.saveAnalysis.mock.calls[0][1]).toEqual(plays);expect(mocks.saveAnalysis.mock.calls[0][1]).toHaveLength(5);
 });
 it('rejects malformed CSV after the matching game instead of stopping verification early',async()=>{
  await setCleanSourceBytes(Buffer.concat([csv(initialPlays),Buffer.from('\n"unterminated quoted record')]));
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_stored_source_invalid'});
  expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it.each(['duplicate','empty'] as const)('enforces the existing %s-header rejection during streaming',async kind=>{
  const bytes=csv(initialPlays).toString('utf8').replace('game_id,home_team',kind==='duplicate'?'game_id,game_id':'game_id,');
  await setCleanSourceBytes(Buffer.from(bytes));
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_stored_source_invalid'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('enforces the one-megabyte CSV record bound even for a different game after the target',async()=>{
  await setCleanSourceBytes(csv([...initialPlays,{...initialPlays[1],game_id:'2026_01_LA_SF',desc:'x'.repeat(1024*1024+1)}]));
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_stored_source_invalid'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('requires raw source bytes to retain their checksum without invoking R',async()=>{
  await setPbp('raw');await writeFile(path.join(directory,'snapshots','snapshots',`${pbp.checksum}.rds`),'corrupt');
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_snapshot_unreadable'});expect(fetchSource).toHaveBeenCalledTimes(1);expect(mocks.runRRequest).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('revalidates complete final PBP, including duplicate play identifiers',async()=>{
  await setPbp('clean',initialPlays.map((row,index)=>index===4?{...row,play_id:3}:row));
  await expect(completePendingGameData(game.id)).rejects.toMatchObject({code:'completion_pbp_incomplete'});expect(fetchSource).not.toHaveBeenCalled();
 });
 it('returns stale on the transactional revision guard and never publishes',async()=>{
  mocks.saveAnalysis.mockRejectedValue(new RevisionConflictError());
  expect(await completePendingGameData(game.id)).toMatchObject({status:'stale',reasonCode:'revision_conflict'});expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('makes a repeated completion a no-op and resumes the guarded publication call',async()=>{
  mocks.saveAnalysis.mockImplementation(async(_game,_plays,snapshots,analysis)=>{report.revision={...report.revision,id:'completed-revision',number:2,analysis:structuredClone(analysis),sourceSnapshots:structuredClone(snapshots)};return {id:'completed-revision',number:2,created:true};});
  mocks.publish.mockRejectedValueOnce(new Error('Publication preparation unavailable'));
  await expect(completePendingGameData(game.id)).rejects.toThrow('Publication preparation unavailable');
  expect(await completePendingGameData(game.id)).toMatchObject({status:'already_complete',revisionId:'completed-revision'});
  expect(fetchSource).toHaveBeenCalledTimes(1);expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);expect(mocks.publish).toHaveBeenCalledTimes(2);
 });
 it('does not fetch for unrelated incomplete reports and identifies invalid stored audit versions',async()=>{
  report.revision.analysis.warnings=['No historical model'];expect(await completePendingGameData(game.id)).toMatchObject({status:'waiting',reasonCode:'not_aggregate_completion_candidate'});
  report.revision.analysis.warnings=[rAnalysis.warnings[1]];report.revision.analysis.gameAudit!.version='under-review-game-audit-v4';
  await expect(completePendingGameData(game.id)).rejects.toBeInstanceOf(DataCompletionError);expect(fetchSource).not.toHaveBeenCalled();
 });
});
