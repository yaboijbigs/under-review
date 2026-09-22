import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { AnalysisResult,Game,GameProfile,GameReport,SourceSnapshot } from '../packages/core/src/contracts.js';
import { GAME_AUDIT_VERSION } from '../packages/core/src/game-audit.js';

const mocks=vi.hoisted(()=>({query:vi.fn(),getReport:vi.fn(),saveAnalysis:vi.fn(),ingest:vi.fn(),reference:vi.fn(),runAnalytics:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
vi.mock('../packages/core/src/repository.js',()=>({getReport:mocks.getReport,saveAnalysis:mocks.saveAnalysis,stableJson:JSON.stringify}));
vi.mock('../packages/core/src/game-profile-source.js',()=>({ingestGameProfiles:mocks.ingest,loadGameProfileReference:mocks.reference}));
vi.mock('../packages/core/src/analytics-bridge.js',()=>({runAnalytics:mocks.runAnalytics}));
import { refreshGameAudit } from '../packages/core/src/audit-refresh.js';

const game:Game={id:'2099_01_TST_DMO',season:2099,week:1,gameType:'REG',awayTeam:'TST',homeTeam:'DMO',homeScore:0,awayScore:0,kickoffAt:'2099-09-01T17:00:00Z',providerData:{result:0,synthetic:true}};
const snapshot=(id:string,provider:string):SourceSnapshot=>({id,provider,checksum:id.repeat(64).slice(0,64),url:`https://example.invalid/${id}`,path:`/synthetic/${id}`,retrievedAt:'2099-09-02T00:00:00Z',license:'Synthetic test only'});
const pbp=snapshot('a','nflverse-pbp'),schedule=snapshot('b','nflverse-schedules'),ftn=snapshot('c','ftn-via-nflverse'),aggregate=snapshot('d','nflverse-team-stats');
const profiles:GameProfile[]=[game.awayTeam,game.homeTeam].map(team=>({gameId:game.id,season:game.season,team,opponent:team===game.homeTeam?game.awayTeam:game.homeTeam,pointsFor:0,pointsAgainst:0,totalYards:200,opponentYards:200,penalties:3,penaltyYards:20,turnoverMargin:0,nonOffensiveTouchdowns:0}));
const plays=Array.from({length:5},(_,index)=>({game_id:game.id,home_team:game.homeTeam,away_team:game.awayTeam,season:game.season,play_id:index,source_order:index,qtr:Math.max(1,index),total_home_score:0,total_away_score:0,desc:index===0?'GAME':index===4?'END GAME':'Synthetic play',play_type:'no_play'}));
const baseAnalysis:AnalysisResult={schemaVersion:1,metrics:[{id:'existing-r-result',category:'coaching',name:'Existing R output',team:game.awayTeam,value:0.023,unit:'wp_delta',status:'supported',eventIds:[],playIds:['2'],assumptions:['Synthetic fixture'],modelVersion:'frozen-model-v1',coverage:{eligible:1,modeled:1}}],events:[],timeline:[{playId:'2',quarter:2,clock:'12:00',homeWp:0.6,description:'Synthetic play'}],coverage:[{category:'coaching',status:'available',eligible:1,modeled:1}],models:[{id:'R-kernel',version:'frozen-model-v1',checksum:'r'.repeat(64),provenance:{unchanged:true}}],warnings:['R source warning preserved','team_stats_unavailable: Previous optional aggregate warning']};
let report:GameReport;
function dbRows(sourceId=pbp.id){return plays.map((data,provider_order)=>({snapshot_id:sourceId,play_id:String(data.play_id),provider_order,data:structuredClone(data)}));}

beforeEach(()=>{
 vi.clearAllMocks();
 report={game:structuredClone(game),revision:{id:'base-revision',number:1,createdAt:'2099-09-02T00:00:00Z',statisticalStatus:'reconciled',chartingStatus:'unavailable',reviewStatus:'not_reviewed',changeSummary:'Synthetic',inputHash:'old-hash',summary:'Synthetic',analysis:structuredClone(baseAnalysis),sourceSnapshots:[schedule,pbp,ftn,snapshot('e','nflverse-team-stats')]},history:[],reviews:[],drafts:[]};
 mocks.getReport.mockImplementation(async()=>structuredClone(report));
 mocks.query.mockResolvedValue({rows:dbRows()});
 mocks.reference.mockResolvedValue({checksum:'f'.repeat(64),reference:{schemaVersion:1,version:'reference-v1',startSeason:1999,endSeason:2025,sourceUrls:[],sourceChecksums:{},rows:[],notes:[]}});
 mocks.ingest.mockResolvedValue({profiles,snapshots:[aggregate],warnings:[]});
 mocks.saveAnalysis.mockResolvedValue({id:'new-revision',number:2,created:true});
});

describe('audit-only immutable report refresh',()=>{
 it('preserves R results and their input snapshots while replacing only audit provenance',async()=>{
  const outcome=await refreshGameAudit(game.id);
  expect(outcome).toMatchObject({created:true,number:2,sourceKind:'clean'});
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('snapshot_id=$2 ORDER BY provider_order'),[game.id,pbp.id]);
  const [savedGame,savedPlays,snapshots,analysis,sourceKind,options]=mocks.saveAnalysis.mock.calls[0];
  expect(savedGame).toEqual(game);expect(savedPlays).toEqual(plays);expect(sourceKind).toBe('clean');
  expect(options).toEqual({expectedBaseRevisionId:'base-revision'});
  for(const key of ['metrics','events','timeline','coverage'] as const)expect(analysis[key]).toEqual(baseAnalysis[key]);
  expect(analysis.models[0]).toEqual(baseAnalysis.models[0]);expect(analysis.models).toHaveLength(2);
  expect(analysis.gameAudit.version).toBe(GAME_AUDIT_VERSION);
  expect(snapshots).toEqual([schedule,pbp,ftn,aggregate]);
  expect(analysis.warnings).toEqual(['R source warning preserved']);
  expect(report.revision.analysis).toEqual(baseAnalysis);
  expect(mocks.runAnalytics).not.toHaveBeenCalled();
 });
 it('is a no-op when the latest complete audit uses the current version and exact reference',async()=>{
  await refreshGameAudit(game.id);
  report.revision={...report.revision,id:'new-revision',number:2,analysis:mocks.saveAnalysis.mock.calls[0][3],sourceSnapshots:mocks.saveAnalysis.mock.calls[0][2]};
  const second=await refreshGameAudit(game.id);
  expect(second).toMatchObject({id:'new-revision',number:2,created:false});
  expect(mocks.saveAnalysis).toHaveBeenCalledTimes(1);expect(mocks.ingest).toHaveBeenCalledTimes(1);
 });
 it('can reuse a complete raw report only through its exact stored normalized PBP snapshot',async()=>{
  const raw={...pbp,id:'raw-source',provider:'nflverse-raw-pbp'};
  report.revision.sourceSnapshots=[schedule,raw,ftn];mocks.query.mockResolvedValue({rows:dbRows(raw.id)});
  expect(await refreshGameAudit(game.id)).toMatchObject({sourceKind:'raw',created:true});
  expect(mocks.query.mock.calls[0][1]).toEqual([game.id,raw.id]);
  expect(mocks.runAnalytics).not.toHaveBeenCalled();
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
  mocks.ingest.mockResolvedValue({profiles:[],snapshots:[aggregate],warnings:['team_stats_score_mismatch: Not final']});
  await refreshGameAudit(game.id);
  const analysis=mocks.saveAnalysis.mock.calls[0][3];
  expect(analysis.gameAudit.status).toBe('insufficient_data');expect(analysis.gameAudit.flags).toEqual([]);
  expect(analysis.gameAudit.profiles.every((profile:GameProfile)=>profile.totalYards===null)).toBe(true);
  expect(analysis.metrics).toEqual(baseAnalysis.metrics);
 });
});
