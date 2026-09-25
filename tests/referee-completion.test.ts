import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AnalysisResult,GameProfile,GameReport,SourceSnapshot } from '../packages/core/src/contracts.js';
import { config,projectRoot } from '../packages/core/src/config.js';
import { normalizePlays,normalizeSchedule,parseCsv,type ProviderRow } from '../packages/core/src/normalize.js';
import { LocalSnapshotStore,SourceError,sourceUrls } from '../packages/core/src/sources.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { loadGameProfileReference } from '../packages/core/src/game-profile-source.js';
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
import { completePendingRefereeData,isPendingRefereeData } from '../packages/core/src/referee-completion.js';

const game=normalizeSchedule({game_id:'2026_03_ATL_GB',season:2026,week:3,game_type:'REG',away_team:'ATL',home_team:'GB',home_score:3,away_score:0,gameday:'2026-09-24',gametime:'20:15',result:3,spread_line:3.5,referee:null});
const plays=normalizePlays(Array.from({length:5},(_,index)=>({game_id:game.id,home_team:game.homeTeam,away_team:game.awayTeam,season:game.season,play_id:index,qtr:Math.max(1,index),total_home_score:index>=3?3:0,total_away_score:0,desc:index===0?'GAME':index===4?'END GAME':'Synthetic test play',play_type:index===1||index===2?'run':index===3?'field_goal':'no_play',posteam:index===1?game.awayTeam:game.homeTeam,defteam:index===1?game.homeTeam:game.awayTeam,yards_gained:index===1?100:index===2?120:0,field_goal_result:index===3?'made':null})),game.id);
const profiles:GameProfile[]=[game.awayTeam,game.homeTeam].map(team=>({gameId:game.id,season:game.season,team,opponent:team===game.homeTeam?game.awayTeam:game.homeTeam,pointsFor:team===game.homeTeam?3:0,pointsAgainst:team===game.homeTeam?0:3,totalYards:team===game.homeTeam?120:100,opponentYards:team===game.homeTeam?100:120,penalties:3,penaltyYards:20,turnoverMargin:0,nonOffensiveTouchdowns:0}));
const rAnalysis:AnalysisResult={schemaVersion:1,metrics:[{id:'saved-r-value',category:'coaching',name:'Saved R result',team:'GB',value:0.023,unit:'wp_delta',status:'supported',eventIds:[],playIds:['2'],assumptions:['Synthetic fixture'],modelVersion:'original-r-model',coverage:{eligible:1,modeled:1}}],events:[],timeline:[{playId:'2',quarter:2,clock:'12:00',homeWp:0.6,description:'Synthetic test play'}],coverage:[{category:'coaching',status:'available',eligible:1,modeled:1}],models:[{id:'R-kernel',version:'original-r-model',checksum:'a'.repeat(64),provenance:{original:true}}],warnings:['Original R warning']};
const snapshot=(provider:string,url:string):SourceSnapshot=>({id:provider,provider,url,checksum:'b'.repeat(64),path:'/untrusted/legacy-path',license:'Synthetic test data',retrievedAt:'2026-09-25T00:00:00Z'});
let report:GameReport,directory:string,fresh:SourceSnapshot,pbp:SourceSnapshot;
let fetchSource:ReturnType<typeof vi.spyOn>;
const originalDataDir=config.dataDir;
const csv=(row:ProviderRow)=>Buffer.from([Object.keys(row).join(','),Object.values(row).map(value=>value===null||value===undefined?'':`"${String(value).replaceAll('"','""')}"`).join(',')].join('\n'));
async function persistSchedule(row:ProviderRow){
 const bytes=csv(row),checksum=createHash('sha256').update(bytes).digest('hex'),folder=path.join(directory,'snapshots','snapshots');
 await mkdir(folder,{recursive:true});const file=path.join(folder,`${checksum}.csv`);await writeFile(file,bytes);
 return {...snapshot('nflverse-schedules',sourceUrls.schedules),id:createHash('sha256').update(`${sourceUrls.schedules}\n${checksum}`).digest('hex'),checksum,path:file};
}
const dbRows=()=>plays.map((data,provider_order)=>({data:structuredClone(data),snapshot_id:pbp.id,play_id:String(data.play_id),provider_order}));
beforeEach(async()=>{
 vi.resetAllMocks();directory=await mkdtemp(path.join(os.tmpdir(),'under-review-referee-'));config.dataDir=directory;
 const schedule=await persistSchedule(game.providerData);fresh=await persistSchedule({...game.providerData,referee:'Carl Cheffers'});
 pbp=snapshot('nflverse-pbp',sourceUrls.clean(game.season));
 const sources=[schedule,pbp,snapshot('ftn-via-nflverse',sourceUrls.ftn(game.season)),snapshot('nflverse-team-stats',`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`)];
 const historical=await loadGameProfileReference(path.join(projectRoot,'analytics/models/game-profiles.json'));
 let analysis=structuredClone(rAnalysis);analysis.gameAudit=buildGameAudit({game,plays,profiles,reference:historical.reference,referenceChecksum:historical.checksum,events:analysis.events});
 analysis=applyExpectationsAudit(game,applySpreadAudit(game,analysis,sources,await loadSpreadReference()),await loadExpectationsReference());
 report={game:structuredClone(game),revision:{id:'original-revision',number:1,createdAt:'2026-09-25T00:00:00Z',statisticalStatus:'reconciled',chartingStatus:'unavailable',reviewStatus:'not_reviewed',changeSummary:'Synthetic',inputHash:'original',summary:'Synthetic',analysis,sourceSnapshots:sources},history:[],reviews:[],drafts:[]};
 mocks.getReport.mockImplementation(async()=>structuredClone(report));mocks.query.mockImplementation(async()=>({rows:dbRows()}));
 mocks.saveAnalysis.mockResolvedValue({id:'referee-revision',number:2,created:true});mocks.publish.mockResolvedValue(undefined);
 fetchSource=vi.spyOn(LocalSnapshotStore.prototype,'fetch').mockImplementation(async source=>{if(source.provider!=='nflverse-schedules')throw new Error('Only schedule fetching is allowed');return fresh;});
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Unexpected network request')));
});
afterEach(async()=>{config.dataDir=originalDataDir;vi.restoreAllMocks();vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});

describe('missing referee completion',()=>{
 it('includes already-rated games with missing identity but excludes absent modules and known sparse-history officials',()=>{
  expect(getGameVerdict(report.revision.analysis.gameAudit).rating).not.toBeNull();expect(isPendingRefereeData(report.revision.analysis)).toBe(true);
  const official=report.revision.analysis.gameAudit!.expectations!.referee;
  official.name='New Official';official.status='schedule_only';official.reasonCode='insufficient_referee_history';expect(isPendingRefereeData(report.revision.analysis)).toBe(false);
  official.status='conflict';expect(isPendingRefereeData(report.revision.analysis)).toBe(false);
  delete report.revision.analysis.gameAudit!.expectations;expect(isPendingRefereeData(report.revision.analysis)).toBe(false);
 });
 it.each(['raw','clean'] as const)('enriches exact schedule provenance while preserving %s PBP, aggregate and R evidence',async kind=>{
  if(kind==='raw'){pbp=snapshot('nflverse-raw-pbp',sourceUrls.raw(game.id));report.revision.sourceSnapshots[1]=pbp;}
  const original=structuredClone(report);
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'updated',revisionId:'referee-revision'});
  const [savedGame,savedPlays,sources,analysis,sourceKind,guard]=mocks.saveAnalysis.mock.calls[0];
  expect(savedGame).toEqual(normalizeSchedule(parseCsv(await new LocalSnapshotStore(path.join(directory,'snapshots')).read(fresh))[0]));
  expect(savedGame.providerData.referee).toBe('Carl Cheffers');expect(savedPlays).toEqual(plays);expect(sourceKind).toBe(kind);expect(guard).toEqual({expectedBaseRevisionId:'original-revision'});
  expect(sources.filter((source:SourceSnapshot)=>source.provider!=='nflverse-schedules')).toEqual(original.revision.sourceSnapshots.filter(source=>source.provider!=='nflverse-schedules'));
  expect(sources.filter((source:SourceSnapshot)=>source.provider==='nflverse-schedules')).toEqual([fresh]);
  for(const field of ['metrics','events','timeline','coverage','warnings'] as const)expect(analysis[field]).toEqual(original.revision.analysis[field]);
  expect(analysis.models.find((model:{id:string})=>model.id==='R-kernel')).toEqual(rAnalysis.models[0]);expect(analysis.gameAudit.profiles).toEqual(original.revision.analysis.gameAudit!.profiles);
  expect(analysis.gameAudit.expectations.referee).toMatchObject({name:'Carl Cheffers',status:'schedule_only'});expect(analysis.gameAudit.expectations.referee.games).toBeGreaterThan(10);
  expect(analysis.gameAudit.market.source.snapshotId).toBe(fresh.id);expect(analysis.gameAudit.market.absoluteError).toBe(original.revision.analysis.gameAudit!.market!.absoluteError);
  expect(report).toEqual(original);expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(game.id);expect(mocks.runAnalytics).not.toHaveBeenCalled();expect(mocks.runRRequest).not.toHaveBeenCalled();
 });
 it('waits without revising or reading PBP when the schedule still lacks the referee',async()=>{
  fresh=await persistSchedule(game.providerData);
  for(let i=0;i<2;i++)expect(await completePendingRefereeData(game.id)).toMatchObject({status:'waiting',reasonCode:'referee_still_missing'});
  expect(mocks.query).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('waits on a provider outage without changing the rated report',async()=>{
  fetchSource.mockRejectedValue(new SourceError('source_http_503','Provider unavailable',true));const original=structuredClone(report);
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'waiting',reasonCode:'source_http_503'});expect(report).toEqual(original);expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it.each([{home_score:6},{spread_line:4},{home_qb_name:'New factual field'},{gametime:'20:30'}])('requires normal analysis when other schedule facts change: %j',async change=>{
  fresh=await persistSchedule({...game.providerData,...change,referee:'Carl Cheffers'});
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'needs_analysis',reasonCode:'referee_schedule_facts_changed'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('does not pretend an unfamiliar referee has a historical adjustment',async()=>{
  fresh=await persistSchedule({...game.providerData,referee:'Synthetic New Official'});
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'updated'});
  const official=mocks.saveAnalysis.mock.calls[0][3].gameAudit.expectations.referee;
  expect(official).toMatchObject({name:'Synthetic New Official',status:'schedule_only',reasonCode:'insufficient_referee_history',games:0,effect:null});
 });
 it('requires the original saved game to reproduce its exact schedule snapshot',async()=>{
  const other=await persistSchedule({...game.providerData,spread_line:7});report.revision.sourceSnapshots[0]=other;
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'needs_analysis',reasonCode:'referee_saved_schedule_mismatch'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('requires ordered matching and final stored PBP',async()=>{
  const rows=dbRows();rows[0].snapshot_id='different';mocks.query.mockResolvedValue({rows});
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'needs_analysis',reasonCode:'referee_pbp_snapshot_mismatch'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue({rows:dbRows().slice(0,-1)});
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'needs_analysis',reasonCode:'referee_pbp_incomplete'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('does not upgrade unrelated historical model references while adding a referee',async()=>{
  report.revision.analysis.gameAudit!.expectations!.reference.checksum='f'.repeat(64);
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'needs_analysis',reasonCode:'referee_model_reference_changed'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('returns stale after a concurrent revision without publishing its discarded result',async()=>{
  mocks.saveAnalysis.mockRejectedValue(new RevisionConflictError());
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'stale',reasonCode:'revision_conflict'});expect(mocks.publish).not.toHaveBeenCalled();
 });
 it('creates only one revision and reuses the guarded initial-publication path after a partial failure',async()=>{
  mocks.saveAnalysis.mockImplementation(async(savedGame,_plays,sources,analysis)=>{report.game=structuredClone(savedGame);report.revision={...report.revision,id:'referee-revision',number:2,analysis:structuredClone(analysis),sourceSnapshots:structuredClone(sources)};return {id:'referee-revision',number:2,created:true};});
  mocks.publish.mockRejectedValueOnce(new Error('Publication temporarily unavailable'));
  await expect(completePendingRefereeData(game.id)).rejects.toThrow('Publication temporarily unavailable');
  expect(await completePendingRefereeData(game.id)).toMatchObject({status:'already_complete',revisionId:'referee-revision'});
  expect(fetchSource).toHaveBeenCalledTimes(1);expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);expect(mocks.publish).toHaveBeenCalledTimes(2);
 });
});
