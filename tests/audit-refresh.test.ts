import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AnalysisResult,Game,GameProfile,GameReport,SourceSnapshot } from '../packages/core/src/contracts.js';
import { GAME_AUDIT_VERSION } from '../packages/core/src/game-audit.js';
import { config } from '../packages/core/src/config.js';
import { LocalSnapshotStore } from '../packages/core/src/sources.js';
import { normalizeSchedule,parseCsv } from '../packages/core/src/normalize.js';

const mocks=vi.hoisted(()=>({query:vi.fn(),getReport:vi.fn(),saveAnalysis:vi.fn(),ingest:vi.fn(),reference:vi.fn(),runAnalytics:vi.fn(),fetch:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
vi.mock('../packages/core/src/repository.js',()=>({getReport:mocks.getReport,saveAnalysis:mocks.saveAnalysis,stableJson:JSON.stringify}));
vi.mock('../packages/core/src/game-profile-source.js',async original=>({...await original<typeof import('../packages/core/src/game-profile-source.js')>(),ingestGameProfiles:mocks.ingest,loadGameProfileReference:mocks.reference}));
vi.mock('../packages/core/src/analytics-bridge.js',()=>({runAnalytics:mocks.runAnalytics}));
import { refreshGameAudit } from '../packages/core/src/audit-refresh.js';

const game=normalizeSchedule({game_id:'2099_01_TST_DMO',season:2099,week:1,game_type:'REG',away_team:'TST',home_team:'DMO',home_score:0,away_score:0,gameday:'2099-09-01',gametime:'13:00',result:0,spread_line:3.5});
const snapshot=(id:string,provider:string):SourceSnapshot=>({id,provider,checksum:id.repeat(64).slice(0,64),url:`https://example.invalid/${id}`,path:`/synthetic/${id}`,retrievedAt:'2099-09-02T00:00:00Z',license:'Synthetic test only'});
const pbp=snapshot('a','nflverse-pbp'),ftn=snapshot('c','ftn-via-nflverse');
let aggregate:SourceSnapshot,schedule:SourceSnapshot;
const profiles:GameProfile[]=[game.awayTeam,game.homeTeam].map(team=>({gameId:game.id,season:game.season,team,opponent:team===game.homeTeam?game.awayTeam:game.homeTeam,pointsFor:0,pointsAgainst:0,totalYards:200,opponentYards:200,penalties:3,penaltyYards:20,turnoverMargin:0,nonOffensiveTouchdowns:0}));
const rawProfiles=profiles.map(profile=>({game_id:game.id,season:game.season,week:game.week,team:profile.team,opponent_team:profile.opponent,passing_yards:0,rushing_yards:200,sack_yards_lost:0,passing_interceptions:0,fumbles_lost_total:0,penalties:3,penalty_yards:20,passing_tds:0,rushing_tds:0,def_tds:0,special_teams_tds:0,fumble_recovery_tds:0,fg_made:0,pat_made:0,passing_2pt_conversions:0,rushing_2pt_conversions:0,def_2pt_made:0,def_safeties:0}));
const csv=(rows:Record<string,unknown>[])=>{const keys=Object.keys(rows[0]);return Buffer.from([keys.join(','),...rows.map(row=>keys.map(key=>String(row[key]??'')).join(','))].join('\n'));};
const plays=Array.from({length:5},(_,index)=>({game_id:game.id,home_team:game.homeTeam,away_team:game.awayTeam,season:game.season,play_id:index,source_order:index,qtr:Math.max(1,index),total_home_score:0,total_away_score:0,desc:index===0?'GAME':index===4?'END GAME':'Synthetic play',play_type:[1,2].includes(index)?'run':'no_play',posteam:index===1?game.awayTeam:game.homeTeam,defteam:index===1?game.homeTeam:game.awayTeam,yards_gained:[1,2].includes(index)?200:0}));
const baseAnalysis:AnalysisResult={schemaVersion:1,metrics:[{id:'existing-r-result',category:'coaching',name:'Existing R output',team:game.awayTeam,value:0.023,unit:'wp_delta',status:'supported',eventIds:[],playIds:['2'],assumptions:['Synthetic fixture'],modelVersion:'frozen-model-v1',coverage:{eligible:1,modeled:1}}],events:[],timeline:[{playId:'2',quarter:2,clock:'12:00',homeWp:0.6,description:'Synthetic play'}],coverage:[{category:'coaching',status:'available',eligible:1,modeled:1}],models:[{id:'R-kernel',version:'frozen-model-v1',checksum:'r'.repeat(64),provenance:{unchanged:true}}],warnings:['R source warning preserved','team_stats_unavailable: Previous optional aggregate warning']};
let report:GameReport;
let temporaryDataDir:string;
const originalDataDir=config.dataDir;
function dbRows(sourceId=pbp.id){return plays.map((data,provider_order)=>({snapshot_id:sourceId,play_id:String(data.play_id),provider_order,data:structuredClone(data)}));}
async function persistAggregate(rows:Record<string,unknown>[]){
 const bytes=csv(rows),checksum=createHash('sha256').update(bytes).digest('hex');
 aggregate={...snapshot(checksum,'nflverse-team-stats'),checksum,url:`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`,path:'/legacy-other-host/snapshots/season.csv'};
 const directory=path.join(temporaryDataDir,'snapshots','snapshots');await mkdir(directory,{recursive:true});
 await writeFile(path.join(directory,`${checksum}.csv`),bytes);
 return aggregate;
}
async function persistSchedule(row=game.providerData){
 const bytes=csv([row]),checksum=createHash('sha256').update(bytes).digest('hex');
 schedule={...snapshot(checksum,'nflverse-schedules'),checksum,url:'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv'};
 const directory=path.join(temporaryDataDir,'snapshots','snapshots');await mkdir(directory,{recursive:true});await writeFile(path.join(directory,`${checksum}.csv`),bytes);
 return normalizeSchedule(parseCsv(bytes)[0]);
}
async function existingV2Audit(){
 await refreshGameAudit(game.id);
 const analysis=structuredClone(mocks.saveAnalysis.mock.calls[0][3]) as AnalysisResult;
 analysis.gameAudit!.version='under-review-game-audit-v2';
 analysis.models.find(model=>model.id==='game-profile-audit')!.version='under-review-game-audit-v2';
 analysis.models=analysis.models.filter(model=>!['overtime-empirical','spread-reference'].includes(model.id));
 delete analysis.gameAudit!.market;
 analysis.timeline=analysis.timeline.filter(point=>(point.quarter??0)<=4);
 analysis.warnings=analysis.warnings.filter(warning=>!warning.startsWith('overtime_model_experimental:'));
 report.revision.analysis=analysis;
 mocks.saveAnalysis.mockClear();
 return structuredClone(analysis);
}

beforeEach(async()=>{
 vi.clearAllMocks();
 temporaryDataDir=await mkdtemp(path.join(os.tmpdir(),'under-review-audit-refresh-'));config.dataDir=temporaryDataDir;
 await persistAggregate(rawProfiles);
 await persistSchedule();
 vi.spyOn(LocalSnapshotStore.prototype,'read');
 mocks.fetch.mockRejectedValue(new Error('External provider unavailable'));vi.stubGlobal('fetch',mocks.fetch);
 report={game:structuredClone(game),revision:{id:'base-revision',number:1,createdAt:'2099-09-02T00:00:00Z',statisticalStatus:'reconciled',chartingStatus:'unavailable',reviewStatus:'not_reviewed',changeSummary:'Synthetic',inputHash:'old-hash',summary:'Synthetic',analysis:structuredClone(baseAnalysis),sourceSnapshots:[schedule,pbp,ftn,aggregate]},history:[],reviews:[],drafts:[]};
 mocks.getReport.mockImplementation(async()=>structuredClone(report));
 mocks.query.mockResolvedValue({rows:dbRows()});
 mocks.reference.mockResolvedValue({checksum:'f'.repeat(64),reference:{schemaVersion:1,version:'reference-v1',startSeason:1999,endSeason:2025,sourceUrls:[],sourceChecksums:{},rows:[],notes:[]}});
 mocks.ingest.mockRejectedValue(new Error('External provider unavailable'));
 mocks.saveAnalysis.mockResolvedValue({id:'new-revision',number:2,created:true});
});
afterEach(async()=>{config.dataDir=originalDataDir;vi.restoreAllMocks();vi.unstubAllGlobals();await rm(temporaryDataDir,{recursive:true,force:true});});

describe('audit-only immutable report refresh',()=>{
 it('preserves R results and their input snapshots while rebuilding from original aggregate evidence',async()=>{
  const outcome=await refreshGameAudit(game.id);
  expect(outcome).toMatchObject({created:true,number:2,sourceKind:'clean'});
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('snapshot_id=$2 ORDER BY provider_order'),[game.id,pbp.id]);
  const [savedGame,savedPlays,snapshots,analysis,sourceKind,options]=mocks.saveAnalysis.mock.calls[0];
  expect(savedGame).toEqual(game);expect(savedPlays).toEqual(plays);expect(sourceKind).toBe('clean');
  expect(options).toEqual({expectedBaseRevisionId:'base-revision'});
  for(const key of ['metrics','events','timeline','coverage'] as const)expect(analysis[key]).toEqual(baseAnalysis[key]);
  expect(analysis.models[0]).toEqual(baseAnalysis.models[0]);expect(analysis.models).toHaveLength(6);
  expect(analysis.models.find((model:{id:string})=>model.id==='game-expectations')).toMatchObject({version:'under-review-expectations-v1'});
  expect(analysis.gameAudit.version).toBe(GAME_AUDIT_VERSION);
  expect(analysis.gameAudit.market).toMatchObject({expectedHomeMargin:3.5,actualHomeMargin:0,absoluteError:3.5,atsResult:'away_covered',source:{checksum:schedule.checksum}});
  expect(snapshots).toEqual([schedule,pbp,ftn,aggregate]);
  expect(analysis.warnings).toEqual(['R source warning preserved']);
  expect(report.revision.analysis).toEqual(baseAnalysis);
  expect(mocks.runAnalytics).not.toHaveBeenCalled();expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
  expect(LocalSnapshotStore.prototype.read).toHaveBeenCalledWith({...aggregate,path:path.join(temporaryDataDir,'snapshots','snapshots',`${aggregate.checksum}.csv`)});
 });
 it('is a no-op when the latest complete audit uses the current version and exact reference',async()=>{
  await refreshGameAudit(game.id);
  report.revision={...report.revision,id:'new-revision',number:2,analysis:mocks.saveAnalysis.mock.calls[0][3],sourceSnapshots:mocks.saveAnalysis.mock.calls[0][2]};
  const second=await refreshGameAudit(game.id);
  expect(second).toMatchObject({id:'new-revision',number:2,created:false});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);expect(LocalSnapshotStore.prototype.read).toHaveBeenCalledTimes(3);expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('can reuse a complete raw report only through its exact stored normalized PBP snapshot',async()=>{
  const raw={...pbp,id:'raw-source',provider:'nflverse-raw-pbp'};
  report.revision.sourceSnapshots=[schedule,raw,ftn];mocks.query.mockResolvedValue({rows:dbRows(raw.id)});
  expect(await refreshGameAudit(game.id)).toMatchObject({sourceKind:'raw',created:true});
  expect(mocks.query.mock.calls[0][1]).toEqual([game.id,raw.id]);
  expect(mocks.runAnalytics).not.toHaveBeenCalled();
 });
 it('adds OT terminal results without rerunning R, and detects a stale OT artifact checksum',async()=>{
  const rows=dbRows();rows.at(-1)!.data.desc='End of regulation';
  rows.push({...rows.at(-1)!,play_id:'5',provider_order:5,data:{...rows.at(-1)!.data,play_id:5,source_order:5,qtr:5,desc:'END GAME'}});
  mocks.query.mockResolvedValue({rows});
  await refreshGameAudit(game.id);
  const refreshed=mocks.saveAnalysis.mock.calls[0][3] as AnalysisResult;
  expect(refreshed.metrics).toEqual(baseAnalysis.metrics);expect(refreshed.timeline[0]).toEqual(baseAnalysis.timeline[0]);
  expect(refreshed.timeline.at(-1)).toMatchObject({playId:'5',status:'observed',homeWp:0,awayWp:0,tieProbability:1});
  report.revision={...report.revision,id:'new-revision',number:2,analysis:structuredClone(refreshed),sourceSnapshots:mocks.saveAnalysis.mock.calls[0][2]};
  expect(await refreshGameAudit(game.id)).toMatchObject({created:false});
  report.revision.analysis.models.find(model=>model.id==='overtime-empirical')!.checksum='0'.repeat(64);
  await refreshGameAudit(game.id);
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(2);expect(mocks.runAnalytics).not.toHaveBeenCalled();
  expect(mocks.saveAnalysis.mock.calls[1][5]).toEqual({expectedBaseRevisionId:'new-revision'});
 });
 it('rejects ambiguous PBP provenance instead of mixing raw and clean inputs',async()=>{
  report.revision.sourceSnapshots.push({...pbp,id:'raw-source',provider:'nflverse-raw-pbp'});
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_pbp_snapshot_ambiguous'});
  expect(mocks.query).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it.each(['wrong-snapshot','wrong-order','wrong-play-id'])('rejects %s stored rows before regenerating the audit',async(kind)=>{
  const rows=dbRows();if(kind==='wrong-snapshot')rows[0].snapshot_id='foreign';if(kind==='wrong-order')rows[1].provider_order=7;if(kind==='wrong-play-id')rows[0].play_id='99';
  mocks.query.mockResolvedValue({rows});
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_pbp_snapshot_mismatch'});
  expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('requires the actual ingestion finality validator even for stored raw reports',async()=>{
  const rows=dbRows();rows.at(-1)!.data.desc='unfinished';mocks.query.mockResolvedValue({rows});
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_pbp_incomplete'});
  expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('propagates a concurrent revision conflict without publishing or overwriting results',async()=>{
  mocks.saveAnalysis.mockRejectedValue(Object.assign(new Error('changed'),{code:'revision_conflict'}));
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'revision_conflict'});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);
 });
 it('leaves historical comparison unavailable when aggregate finality is not established',async()=>{
  report.revision.sourceSnapshots=[schedule,pbp,ftn,await persistAggregate(rawProfiles.map(row=>({...row,passing_tds:1})))];
  await refreshGameAudit(game.id);
  const analysis=mocks.saveAnalysis.mock.calls[0][3];
  expect(analysis.gameAudit.status).toBe('insufficient_data');expect(analysis.gameAudit.flags).toEqual([]);
  expect(analysis.gameAudit.profiles.every((profile:GameProfile)=>profile.totalYards===null)).toBe(true);
  expect(analysis.metrics).toEqual(baseAnalysis.metrics);
  expect(analysis.warnings).toEqual(expect.arrayContaining([expect.stringContaining('team_stats_score_mismatch:')]));
  expect(mocks.fetch).not.toHaveBeenCalled();
  report.revision={...report.revision,id:'new-revision',number:2,analysis};
  expect(await refreshGameAudit(game.id)).toMatchObject({created:false,id:'new-revision'});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);
 });
 it('upgrades v2 with identical validated profiles, flags and provenance during a provider outage, adding only OT estimates and model metadata',async()=>{
  report.game=await persistSchedule({...game.providerData,home_score:3,result:3});
  report.revision.sourceSnapshots=[schedule,pbp,ftn,await persistAggregate(rawProfiles.map(row=>({...row,penalty_yards:133,fg_made:row.team===game.homeTeam?1:0})))];
  const rows=dbRows();rows.at(-1)!.data.desc='End of regulation';
  rows.push({...rows.at(-1)!,play_id:'5',provider_order:5,data:{...rows.at(-1)!.data,play_id:5,source_order:5,qtr:5,desc:'Synthetic field goal',total_home_score:3,play_type:'field_goal'}});
  Object.assign(rows.at(-1)!.data,{field_goal_result:'made',field_goal_attempt:1});
  rows.push({...rows[4],play_id:'6',provider_order:6,data:{...rows[4].data,play_id:6,source_order:6,qtr:5,desc:'END GAME',total_home_score:3}});
  mocks.query.mockResolvedValue({rows});
  const previous=await existingV2Audit();
  expect(previous.gameAudit!.flags.length).toBeGreaterThan(0);
  const sources=structuredClone(report.revision.sourceSnapshots);
  await refreshGameAudit(game.id);
  const [,,,analysis]=mocks.saveAnalysis.mock.calls[0];
  expect(analysis.gameAudit.version).toBe(GAME_AUDIT_VERSION);
  expect(analysis.gameAudit.profiles).toEqual(previous.gameAudit!.profiles);
  expect(analysis.gameAudit.flags).toEqual(previous.gameAudit!.flags);
  expect(analysis.gameAudit.reference).toEqual(previous.gameAudit!.reference);
  expect(mocks.saveAnalysis.mock.calls[0][2]).toEqual(sources);
  for(const field of ['metrics','events','coverage'] as const)expect(analysis[field]).toEqual(previous[field]);
  expect(analysis.models[0]).toEqual(previous.models[0]);
  expect(analysis.timeline[0]).toEqual(previous.timeline[0]);
  expect(analysis.timeline.at(-1)).toMatchObject({playId:'6',status:'observed',homeWp:1,awayWp:0,tieProbability:0});
  expect(mocks.runAnalytics).not.toHaveBeenCalled();expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
  report.revision={...report.revision,id:'new-revision',number:2,analysis};
  expect(await refreshGameAudit(game.id)).toMatchObject({created:false,id:'new-revision'});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);
 });
 it.each(['missing','corrupt'])('preserves a complete v2 report when its original aggregate snapshot is %s',async(kind)=>{
  const previous=await existingV2Audit();
  const file=path.join(temporaryDataDir,'snapshots','snapshots',`${aggregate.checksum}.csv`);
  if(kind==='missing')await rm(file);else await writeFile(file,'corrupt snapshot');
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_aggregate_snapshot_unreadable'});
  expect(report.revision.analysis).toEqual(previous);expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('preserves complete v2 profiles when immutable aggregate evidence fails the current finality gate',async()=>{
  const previous=await existingV2Audit();
  report.revision.sourceSnapshots=[schedule,pbp,ftn,await persistAggregate(rawProfiles.map(row=>({...row,passing_tds:1})))];
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_aggregate_snapshot_invalid'});
  expect(report.revision.analysis).toEqual(previous);expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('rejects a changed stored line instead of inventing snapshot provenance',async()=>{
  report.game.providerData.spread_line=-9;
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_schedule_snapshot_mismatch'});
  expect(mocks.saveAnalysis).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('upgrades v3 to v4 without changing any regulation or OT values, R outputs, profiles or snapshots',async()=>{
  await refreshGameAudit(game.id);
  report.revision.analysis=structuredClone(mocks.saveAnalysis.mock.calls[0][3]);
  report.revision.analysis.gameAudit!.version='under-review-game-audit-v3';
  report.revision.analysis.models.find(model=>model.id==='game-profile-audit')!.version='under-review-game-audit-v3';
  report.revision.analysis.models=report.revision.analysis.models.filter(model=>model.id!=='spread-reference');
  delete report.revision.analysis.gameAudit!.market;
  const previous=structuredClone(report.revision.analysis);mocks.saveAnalysis.mockClear();
  await refreshGameAudit(game.id);
  const [,savedPlays,sources,analysis]=mocks.saveAnalysis.mock.calls[0];
  for(const field of ['metrics','events','coverage','timeline'] as const)expect(analysis[field]).toEqual(previous[field]);
  expect(analysis.gameAudit.profiles).toEqual(previous.gameAudit!.profiles);expect(analysis.gameAudit.flags).toEqual(previous.gameAudit!.flags);
  expect(analysis.gameAudit.market).toMatchObject({expectedHomeMargin:3.5,source:{checksum:schedule.checksum}});
  expect(sources).toEqual(report.revision.sourceSnapshots);expect(savedPlays).toEqual(plays);
  expect(mocks.runAnalytics).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('preserves a v3 report when its schedule evidence is corrupt',async()=>{
  const previous=await existingV2Audit();report.revision.analysis.gameAudit!.version='under-review-game-audit-v3';
  await writeFile(path.join(temporaryDataDir,'snapshots','snapshots',`${schedule.checksum}.csv`),'corrupt');
  await expect(refreshGameAudit(game.id)).rejects.toMatchObject({code:'audit_schedule_snapshot_unreadable'});
  expect(report.revision.analysis.metrics).toEqual(previous.metrics);expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
});
