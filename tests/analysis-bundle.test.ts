import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { config,projectRoot } from '../packages/core/src/config.js';
import type { AnalysisResult,GameReport,SourceSnapshot } from '../packages/core/src/contracts.js';
import { normalizePlays,normalizeSchedule,parseCsv } from '../packages/core/src/normalize.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { loadGameProfileReference,normalizeGameProfiles } from '../packages/core/src/game-profile-source.js';
import { sourceUrls,SOURCE_LICENSES } from '../packages/core/src/sources.js';

const mocks=vi.hoisted(()=>({query:vi.fn(),getReport:vi.fn(),saveAnalysis:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query,transaction:vi.fn()}));
vi.mock('../packages/core/src/repository.js',async original=>({...await original<typeof import('../packages/core/src/repository.js')>(),getReport:mocks.getReport,saveAnalysis:mocks.saveAnalysis}));
import { stableJson } from '../packages/core/src/repository.js';
import { analysisBundleProducer,exportAnalysisBundle,importAnalysisBundle,type AnalysisBundle,type AnalysisBundleProducer } from '../packages/core/src/analysis-bundle.js';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
function resign(bundle:AnalysisBundle){const {checksum,...payload}=bundle;bundle.checksum=hash(stableJson(payload));return bundle;}
const csv=(rows:Record<string,unknown>[])=>{const fields=[...new Set(rows.flatMap(Object.keys))];return [fields.join(','),...rows.map(row=>fields.map(field=>`"${String(row[field]??'').replaceAll('"','""')}"`).join(','))].join('\n');};
const sourceSchedule={game_id:'2099_01_TST_DMO',season:2099,week:1,game_type:'REG',home_team:'DMO',away_team:'TST',home_score:0,away_score:0,result:0,gameday:'2099-09-01',gametime:'13:00'};
const game=normalizeSchedule(parseCsv(csv([sourceSchedule]))[0]);
const rawPlays=Array.from({length:5},(_,index)=>({game_id:game.id,home_team:game.homeTeam,away_team:game.awayTeam,season:game.season,play_id:index,qtr:Math.max(1,index),total_home_score:0,total_away_score:0,desc:index===0?'GAME':index===4?'END GAME':'Synthetic play',play_type:index===1||index===2?'run':'no_play',yards_gained:0,posteam:index===1?'TST':index===2?'DMO':null,defteam:index===1?'DMO':index===2?'TST':null}));
const plays=normalizePlays(parseCsv(csv(rawPlays)),game.id);
const rawProfiles=[game.awayTeam,game.homeTeam].map(team=>({game_id:game.id,season:game.season,week:1,team,opponent_team:team===game.homeTeam?game.awayTeam:game.homeTeam,passing_yards:0,rushing_yards:0,sack_yards_lost:0,passing_interceptions:0,fumbles_lost_total:0,penalties:0,penalty_yards:0,passing_tds:0,rushing_tds:0,def_tds:0,special_teams_tds:0,fumble_recovery_tds:0,fg_made:0,pat_made:0,passing_2pt_conversions:0,rushing_2pt_conversions:0,def_2pt_made:0,def_safeties:0}));
let producer:AnalysisBundleProducer,historical:Awaited<ReturnType<typeof loadGameProfileReference>>;
let directory:string,report:GameReport;
const originalDataDir=config.dataDir;

async function saveSource(provider:string,url:string,text:string):Promise<SourceSnapshot>{
 const checksum=hash(text);const destination=path.join(config.dataDir,'snapshots','snapshots',`${checksum}.csv`);
 await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,text);
 return {id:hash(`${url}\n${checksum}`),provider,url,checksum,path:destination,retrievedAt:'2099-09-02T00:00:00.000Z',license:provider==='ftn-via-nflverse'?SOURCE_LICENSES.ftn:SOURCE_LICENSES.nflverse,metadata:{attribution:'Synthetic test fixture'}};
}
beforeAll(async()=>{producer=await analysisBundleProducer();historical=await loadGameProfileReference(path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'game-profiles.json'));});
beforeEach(async()=>{
 vi.clearAllMocks();directory=await mkdtemp(path.join(tmpdir(),'under-review-bundle-test-'));config.dataDir=path.join(directory,'export');
 const snapshots=await Promise.all([
  saveSource('nflverse-schedules',sourceUrls.schedules,csv([sourceSchedule])),saveSource('nflverse-pbp',sourceUrls.clean(game.season),csv(rawPlays)),
  saveSource('ftn-via-nflverse',sourceUrls.ftn(game.season),csv([{nflverse_game_id:game.id,nflverse_play_id:1,is_drop:0}])),
  saveSource('nflverse-team-stats',`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`,csv(rawProfiles))]);
 const analysis:AnalysisResult={schemaVersion:1,metrics:[{id:`${game.id}:synthetic`,category:'coaching',name:'Synthetic result',team:'TST',value:0.02,unit:'wp_delta',status:'supported',eventIds:[`${game.id}:2`],playIds:['2'],assumptions:['Synthetic test only'],modelVersion:producer.models['nfl4th-adapted'].version,coverage:{eligible:1,modeled:1}}],events:[{id:`${game.id}:2`,playId:'2',quarter:2,clock:'12:00',description:'Synthetic play',kind:'coaching',team:'DMO',reviewStatus:'not_reviewed'}],timeline:[],coverage:[],models:Object.entries(producer.models).map(([id,model])=>({id,...model})),warnings:[]};
 analysis.gameAudit=buildGameAudit({game,plays,profiles:normalizeGameProfiles(game,rawProfiles),reference:historical.reference,referenceChecksum:historical.checksum,events:analysis.events});
 report={game,revision:{id:'local-revision',number:1,createdAt:'2099-09-02T00:00:00Z',statisticalStatus:'reconciled',chartingStatus:'unavailable',reviewStatus:'not_reviewed',changeSummary:'Synthetic',summary:'Synthetic',inputHash:'synthetic',analysis,sourceSnapshots:snapshots},reviews:[],drafts:[],history:[]};
 mocks.getReport.mockImplementation(async()=>structuredClone(report));
 mocks.query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT 1 FROM events')?{rows:[],rowCount:0}:sql.startsWith('SELECT snapshot_id')?{rows:plays.map((data,index)=>({snapshot_id:snapshots[1].id,play_id:String(data.play_id),provider_order:index,data})),rowCount:plays.length}:{rows:[],rowCount:0});
 mocks.saveAnalysis.mockResolvedValue({id:'destination-revision',number:1,created:true});
});
afterEach(async()=>{
 config.dataDir=originalDataDir;
 const intended=path.resolve(tmpdir())+path.sep+'under-review-bundle-test-';
 if(!path.resolve(directory).startsWith(intended))throw new Error('Unsafe generated test cleanup path.');
 await rm(directory,{recursive:true,force:true});
});
async function bundleForImport(){const bundle=await exportAnalysisBundle(game.id);config.dataDir=path.join(directory,'import');mocks.getReport.mockResolvedValue(null);return bundle;}

describe('bounded clean analysis evidence bundles',()=>{
 it('exports no local paths or operational state and preserves original licensed source bytes',async()=>{
  const bundle=await exportAnalysisBundle(game.id);
  expect(Object.keys(bundle).sort()).toEqual(['analysis','checksum','game','plays','producer','schemaVersion','snapshots','sourceKind']);
  expect(JSON.stringify(bundle)).not.toContain(directory);expect(bundle.snapshots.every(item=>!('path' in item.snapshot))).toBe(true);
  expect(bundle.snapshots.find(item=>item.snapshot.provider==='ftn-via-nflverse')?.snapshot.license).toBe('CC-BY-SA-4.0');
  for(const item of bundle.snapshots)expect(hash(Buffer.from(item.bytesBase64,'base64'))).toBe(item.snapshot.checksum);
 });
 it('uses canonical content-addressed bytes when the DB retains another host absolute path',async()=>{
  for(const source of report.revision.sourceSnapshots)source.path='Z:\\legacy-host\\must-not-read.csv';
  const bundle=await exportAnalysisBundle(game.id);
  expect(bundle.snapshots).toHaveLength(4);expect(JSON.stringify(bundle)).not.toContain('legacy-host');
 });
 it('round-trips multi-megabyte base64 source bytes without a regexp stack overflow',async()=>{
  const scheduleBytes=csv([sourceSchedule])+'\n'.repeat(2*1024*1024);
  report.revision.sourceSnapshots[0]=await saveSource('nflverse-schedules',sourceUrls.schedules,scheduleBytes);
  const bundle=await bundleForImport();await importAnalysisBundle(bundle);
  expect(Buffer.from(bundle.snapshots[0].bytesBase64,'base64').length).toBeGreaterThan(2*1024*1024);
 });
 it('imports under content-addressed destination paths with an absence guard and publishing disabled',async()=>{
  const bundle=await bundleForImport();expect(await importAnalysisBundle(bundle)).toMatchObject({gameId:game.id,number:1,created:true,bundleChecksum:bundle.checksum});
  const [savedGame,savedPlays,sources,analysis,kind,options]=mocks.saveAnalysis.mock.calls[0];
  expect(savedGame).toEqual(game);expect(savedPlays).toEqual(plays);expect(analysis).toEqual(report.revision.analysis);expect(kind).toBe('clean');
  expect(options).toEqual({expectedBaseRevisionId:null,preventPublication:true});
  for(const source of sources as SourceSnapshot[]){expect(source.path.startsWith(path.join(config.dataDir,'snapshots','snapshots')+path.sep)).toBe(true);expect(hash(await readFile(source.path))).toBe(source.checksum);}
 });
 it('reimports identical evidence against its existing destination revision without duplication',async()=>{
  const bundle=await bundleForImport();await importAnalysisBundle(bundle);
  const sources=mocks.saveAnalysis.mock.calls[0][2];
  mocks.getReport.mockResolvedValue({...report,revision:{...report.revision,id:'destination-revision',sourceSnapshots:sources}});
  mocks.query.mockResolvedValue({rows:sources.map((snapshot_json:SourceSnapshot)=>({snapshot_json}))});
  mocks.saveAnalysis.mockResolvedValue({id:'destination-revision',number:1,created:false});
  expect(await importAnalysisBundle(bundle)).toMatchObject({created:false,id:'destination-revision'});
  expect(mocks.saveAnalysis.mock.calls[1][5]).toEqual({expectedBaseRevisionId:'destination-revision',preventPublication:true});
 });
 it.each(['reviews','manual','raw'])('refuses to export %s inputs',async(kind)=>{
  if(kind==='reviews')report.reviews.push({} as never);
  if(kind==='manual')mocks.query.mockResolvedValue({rowCount:1,rows:[]});
  if(kind==='raw')report.revision.sourceSnapshots[1].provider='nflverse-raw-pbp';
  await expect(exportAnalysisBundle(game.id)).rejects.toMatchObject({code:kind==='raw'?'bundle_raw_unsupported':'bundle_human_state'});
 });
 it('rejects a changed bundle body before writing files or database rows',async()=>{
  const bundle=await bundleForImport();bundle.analysis.metrics[0].value=0.9;
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_checksum_mismatch'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
 });
 it('rejects tampered original source bytes even with a recomputed envelope checksum',async()=>{
  const bundle=await bundleForImport();bundle.snapshots[1].bytesBase64=Buffer.from('wrong-source').toString('base64');resign(bundle);
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_snapshot_checksum'});
 });
 it('rejects model/code mismatches and altered declared analysis model versions',async()=>{
  const bundle=await bundleForImport();const changed=structuredClone(bundle);changed.producer.files['analytics/R/engine.R']='0'.repeat(64);resign(changed);
  await expect(importAnalysisBundle(changed)).rejects.toMatchObject({code:'bundle_producer_mismatch'});
  bundle.analysis.models[0].version='unmatched-version';resign(bundle);
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_model_mismatch'});
 });
 it('rejects played-row, schedule and audit claims which do not match bundled source bytes',async()=>{
  const bundle=await bundleForImport();const changedPlays=structuredClone(bundle);changedPlays.plays[1].yards_gained=100;resign(changedPlays);
  await expect(importAnalysisBundle(changedPlays)).rejects.toMatchObject({code:'bundle_play_mismatch'});
  const changedGame=structuredClone(bundle);changedGame.game.homeScore=10;resign(changedGame);
  await expect(importAnalysisBundle(changedGame)).rejects.toMatchObject({code:'bundle_schedule_mismatch'});
  bundle.analysis.gameAudit!.headline='Unsupported claim';resign(bundle);
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_audit_mismatch'});
 });
 it('accepts an honest audit with withheld aggregate profiles after the same conservative gate fails',async()=>{
  const rows=structuredClone(rawProfiles);rows[0].passing_tds=1;
  report.revision.sourceSnapshots[3]=await saveSource('nflverse-team-stats',report.revision.sourceSnapshots[3].url,csv(rows));
  report.revision.analysis.gameAudit=buildGameAudit({game,plays,profiles:[],reference:historical.reference,referenceChecksum:historical.checksum,events:report.revision.analysis.events});
  report.revision.analysis.warnings=['team_stats_score_mismatch: Profiles withheld.'];
  const bundle=await bundleForImport();await importAnalysisBundle(bundle);
  expect(mocks.saveAnalysis.mock.calls[0][3].gameAudit.profiles.every((profile:{totalYards:number|null})=>profile.totalYards===null)).toBe(true);
 });
 it('rejects local-path injection and source host/identity substitution',async()=>{
  const bundle=await bundleForImport();const injected=structuredClone(bundle) as AnalysisBundle&{snapshots:{snapshot:{path?:string}}[]};injected.snapshots[0].snapshot.path='../../outside';resign(injected);
  await expect(importAnalysisBundle(injected)).rejects.toMatchObject({code:'bundle_schema_invalid'});
  bundle.snapshots[0].snapshot.url='https://example.invalid/not-the-provider';resign(bundle);
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_source_identity'});
 });
 it('refuses a symlinked snapshot directory before creating anything outside the data directory',async()=>{
  const bundle=await bundleForImport();const outside=path.join(directory,'outside');await mkdir(outside);await mkdir(config.dataDir);
  await symlink(outside,path.join(config.dataDir,'snapshots'),'junction');
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_path_rejected'});
  await expect(readFile(path.join(outside,'snapshots',`${bundle.snapshots[0].snapshot.checksum}.csv`))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('does not replace a different existing destination report and propagates a later concurrent conflict',async()=>{
  const bundle=await bundleForImport();const existing=structuredClone(report);existing.revision.analysis.metrics[0].value=0.8;mocks.getReport.mockResolvedValue(existing);
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'bundle_destination_has_report'});expect(mocks.saveAnalysis).not.toHaveBeenCalled();
  mocks.getReport.mockResolvedValue(null);mocks.saveAnalysis.mockRejectedValue(Object.assign(new Error('new revision won'),{code:'revision_conflict'}));
  await expect(importAnalysisBundle(bundle)).rejects.toMatchObject({code:'revision_conflict'});
 });
});
