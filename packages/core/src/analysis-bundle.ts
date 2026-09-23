import { createHash } from 'node:crypto';
import { lstat,mkdir,readFile,realpath,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config,projectRoot } from './config.js';
import { query } from './db.js';
import { analysisSchema,gameSchema,type AnalysisResult,type Game,type SourceSnapshot } from './contracts.js';
import { getReport,saveAnalysis,stableJson } from './repository.js';
import { assertGameId,normalizePlays,normalizeSchedule,parseCsv,validateGameData } from './normalize.js';
import { LocalSnapshotStore,SOURCE_LICENSES,sourceUrls } from './sources.js';
import { buildGameAudit,GAME_AUDIT_VERSION } from './game-audit.js';
import { loadGameProfileReference,normalizeGameProfiles,validateGameProfileFinality } from './game-profile-source.js';
import { applyOvertimeTimeline,loadOvertimeReference,OVERTIME_MODEL_ID } from './overtime-integration.js';
import { OVERTIME_MODEL_VERSION } from './overtime.js';
import { buildMarketAudit,loadSpreadReference,SPREAD_MODEL_ID,SPREAD_VERSION,applySpreadAudit } from './spread.js';
import { loadExpectationsReference,EXPECTATIONS_VERSION } from './expectations.js';
import { applyExpectationsAudit,EXPECTATIONS_MODEL_ID } from './expectations-integration.js';

// Deliberately bounded for the current-season catch-up, not whole-database transport.
export const MAX_ANALYSIS_BUNDLE_BYTES=64*1024*1024;
const MAX_SNAPSHOT_BYTES=32*1024*1024;
const sha256=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const modelSchema=z.object({version:z.string().min(1),checksum:hashSchema.optional()}).strict();
const producerSchema=z.object({format:z.literal('under-review-analysis-bundle-v1'),closeCallTolerance:z.number().finite(),files:z.record(z.string(),hashSchema),models:z.record(z.string(),modelSchema)}).strict();
const snapshotSchema=z.object({id:hashSchema,provider:z.enum(['nflverse-schedules','nflverse-pbp','ftn-via-nflverse','nflverse-team-stats']),url:z.string().url(),retrievedAt:z.string().datetime({offset:true}),checksum:hashSchema,providerVersion:z.string().optional(),license:z.string(),metadata:z.record(z.string(),z.unknown()).optional()}).strict();
const payloadSchema=z.object({schemaVersion:z.literal(1),producer:producerSchema,game:gameSchema.strict(),sourceKind:z.literal('clean'),analysis:analysisSchema.strict(),plays:z.array(z.record(z.string(),z.unknown())).min(1).max(1000),snapshots:z.array(z.object({snapshot:snapshotSchema,bytesBase64:z.string().min(1).max(Math.ceil(MAX_SNAPSHOT_BYTES/3)*4)}).strict()).min(2).max(4)}).strict();
const bundleSchema=payloadSchema.extend({checksum:hashSchema}).strict();
export type AnalysisBundle=z.infer<typeof bundleSchema>;
export type AnalysisBundleProducer=z.infer<typeof producerSchema>;
export class AnalysisBundleError extends Error {
 constructor(public readonly code:string,message:string){super(message);this.name='AnalysisBundleError';}
}
function fail(code:string,message:string):never{throw new AnalysisBundleError(code,message);}
const CODE_FILES=['analytics/renv.lock','analytics/run.R','analytics/R/common.R','analytics/R/states.R','analytics/R/fourth.R','analytics/R/baselines.R','analytics/R/engine.R','analytics/R/rarity.R',
 'analytics/vendor/nfl4th/helpers.R','analytics/vendor/nfl4th/decision_functions.R','analytics/vendor/nfl4th/apply_win_prob.R','analytics/vendor/nfl4th/wrapper.R',
 'packages/core/src/normalize.ts','packages/core/src/game-audit.ts','packages/core/src/game-profile-source.ts','packages/core/src/overtime.ts','packages/core/src/overtime-integration.ts','packages/core/src/spread.ts',
 'packages/core/src/expectations.ts','packages/core/src/expectations-contracts.ts','packages/core/src/expectations-integration.ts','packages/core/src/consumer-summary.ts','packages/core/reference/expectations-reference.json'];
const MODEL_FILES=['manifest.json','evaluation.json','coaching-evaluation.json','category-reference.json','game-profiles.json','overtime-reference.json','spread-reference.json','fd_model.rds','wp_model.rds','fg_model.rds','two_pt_model.rds','punt_df.rds','fastr_ep_model.rds','fastr_wp_model.rds','fastr_wp_model_spread.rds','fumble.rds','fg.rds','xp.rds','penalty.rds','kickoff_starts.rds'];
const modelDirectory=()=>process.env.MODEL_DIR??path.join(projectRoot,'analytics/models');

/** The trusted local runtime, never filenames or executable instructions from a bundle. */
export async function analysisBundleProducer():Promise<AnalysisBundleProducer>{
 const files:Record<string,string>={};
 for(const file of CODE_FILES)files[file]=sha256(await readFile(path.join(projectRoot,file)));
 for(const file of MODEL_FILES)files[`models/${file}`]=sha256(await readFile(path.join(modelDirectory(),file)));
 const manifest=JSON.parse(await readFile(path.join(modelDirectory(),'manifest.json'),'utf8')) as {modelVersion:string;artifacts:{file:string;sha256:string}[]};
 const baseline=JSON.parse(await readFile(path.join(modelDirectory(),'evaluation.json'),'utf8')) as {version:string};
 if(!manifest.modelVersion||!baseline.version||!Array.isArray(manifest.artifacts)||manifest.artifacts.some(artifact=>files[`models/${artifact.file}`]!==artifact.sha256))fail('bundle_local_models_invalid','Local frozen model artifacts do not match their manifest.');
 const states=await readFile(path.join(projectRoot,'analytics/R/states.R'),'utf8');
 const wpVersion=/^WP_VERSION\s*<-\s*"([^"]+)"/m.exec(states)?.[1];
 if(!wpVersion)fail('bundle_local_models_invalid','The pinned win-probability version could not be established.');
 const models:AnalysisBundleProducer['models']={nflfastR:{version:wpVersion},'nfl4th-adapted':{version:manifest.modelVersion,checksum:files['models/manifest.json']},'game-profile-audit':{version:GAME_AUDIT_VERSION,checksum:files['models/game-profiles.json']}};
 for(const name of ['fumble','fg','xp','penalty'])models[name]={version:baseline.version,checksum:files[`models/${name}.rds`]};
 const overtime=await loadOvertimeReference(path.join(modelDirectory(),'overtime-reference.json'));
 if(overtime.checksum!==files['models/overtime-reference.json'])fail('bundle_local_models_invalid','The overtime reference changed while validating its producer fingerprint.');
 models[OVERTIME_MODEL_ID]={version:OVERTIME_MODEL_VERSION,checksum:overtime.checksum};
 const spread=await loadSpreadReference();
 if(spread.checksum!==files['models/spread-reference.json'])fail('bundle_local_models_invalid','The spread reference changed while validating its producer fingerprint.');
 models[SPREAD_MODEL_ID]={version:SPREAD_VERSION,checksum:spread.checksum};
 const expectations=await loadExpectationsReference();
 if(expectations.checksum!==files['packages/core/reference/expectations-reference.json'])fail('bundle_local_models_invalid','The expectation reference changed during validation.');
 models[EXPECTATIONS_MODEL_ID]={version:EXPECTATIONS_VERSION,checksum:expectations.checksum};
 return producerSchema.parse({format:'under-review-analysis-bundle-v1',closeCallTolerance:config.closeCallTolerance,files,models});
}

function checkModels(analysis:AnalysisResult,producer:AnalysisBundleProducer):void{
 const actual:AnalysisBundleProducer['models']={};
 for(const model of analysis.models){
  if(Object.hasOwn(actual,model.id))fail('bundle_model_mismatch','Analysis has duplicate model identities.');
  actual[model.id]={version:model.version,...(model.checksum?{checksum:model.checksum}:{})};
 }
 if(stableJson(actual)!==stableJson(producer.models))fail('bundle_model_mismatch','Analysis model versions or checksums do not match the frozen local runtime.');
}

function sourceIdentity(game:Game,snapshot:z.infer<typeof snapshotSchema>):void{
 const expected:Record<string,string>={'nflverse-schedules':sourceUrls.schedules,'nflverse-pbp':sourceUrls.clean(game.season),'ftn-via-nflverse':sourceUrls.ftn(game.season),'nflverse-team-stats':`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${game.season}.csv`};
 if(snapshot.url!==expected[snapshot.provider]||snapshot.id!==sha256(`${snapshot.url}\n${snapshot.checksum}`))fail('bundle_source_identity','Source identity or URL does not match this game and immutable checksum.');
 if(snapshot.license!==(snapshot.provider==='ftn-via-nflverse'?SOURCE_LICENSES.ftn:SOURCE_LICENSES.nflverse))fail('bundle_source_license','Source license attribution does not match its provider.');
}

async function validateBundle(input:unknown):Promise<{bundle:AnalysisBundle;bytes:Map<string,Buffer>}>{
 if(Buffer.byteLength(JSON.stringify(input)??'')>MAX_ANALYSIS_BUNDLE_BYTES)fail('bundle_too_large','Analysis bundle exceeds the 64 MiB transfer limit.');
 const parsed=bundleSchema.safeParse(input);
 if(!parsed.success)fail('bundle_schema_invalid','Analysis bundle failed the strict transfer schema.');
 const bundle=parsed.data;const {checksum,...payload}=bundle;
 if(sha256(stableJson(payload))!==checksum)fail('bundle_checksum_mismatch','Analysis bundle checksum is invalid.');
 assertGameId(bundle.game.id);
 const local=await analysisBundleProducer();
 if(stableJson(bundle.producer)!==stableJson(local))fail('bundle_producer_mismatch','Bundle and destination code, model artifacts or analysis configuration differ.');
 checkModels(bundle.analysis,local);
 const bytes=new Map<string,Buffer>();const providers=new Set<string>();
 for(const item of bundle.snapshots){
  const {snapshot,bytesBase64}=item;sourceIdentity(bundle.game,snapshot);
  if(providers.has(snapshot.provider)||bytes.has(snapshot.id))fail('bundle_source_identity','Duplicate source provider or immutable snapshot.');
  // Canonical round-trip below rejects malformed base64 without a regex that can
  // exhaust the JavaScript regexp stack on multi-megabyte provider releases.
  if(bytesBase64.length%4!==0)fail('bundle_snapshot_encoding','Snapshot is not canonical base64.');
  const data=Buffer.from(bytesBase64,'base64');
  if(!data.length||data.length>MAX_SNAPSHOT_BYTES||data.toString('base64')!==bytesBase64||sha256(data)!==snapshot.checksum)fail('bundle_snapshot_checksum','Snapshot bytes do not match their immutable checksum.');
  providers.add(snapshot.provider);bytes.set(snapshot.id,data);
 }
 const source=(provider:string)=>bundle.snapshots.find(item=>item.snapshot.provider===provider);
 const schedule=source('nflverse-schedules');const pbp=source('nflverse-pbp');
 if(!schedule||!pbp)fail('bundle_source_identity','A clean PBP source and schedule source are required.');
 const scheduleRows=parseCsv(bytes.get(schedule.snapshot.id)!).filter(row=>row.game_id===bundle.game.id);
 if(scheduleRows.length!==1||stableJson(normalizeSchedule(scheduleRows[0]))!==stableJson(bundle.game))fail('bundle_schedule_mismatch','Bundled game differs from its exact schedule snapshot.');
 const normalized=normalizePlays(parseCsv(bytes.get(pbp.snapshot.id)!),bundle.game.id);
 if(stableJson(normalized)!==stableJson(bundle.plays))fail('bundle_play_mismatch','Ordered plays differ from the bundled clean source snapshot.');
 const finality=validateGameData(bundle.game,bundle.plays);
 if(!finality.valid)fail('bundle_game_incomplete',`Bundled game is not complete and final: ${finality.issues.join(', ')}.`);
 const playIds=new Set(bundle.plays.map(play=>String(play.play_id)));
 if(bundle.analysis.events.some(event=>!event.id.startsWith(`${bundle.game.id}:`)||!playIds.has(event.playId)||event.reviewStatus!=='not_reviewed'||event.kind==='manual')
  ||bundle.analysis.timeline.some(point=>!playIds.has(point.playId))||bundle.analysis.metrics.some(metric=>!metric.id.startsWith(`${bundle.game.id}:`)||metric.playIds.some(id=>!playIds.has(id)))){
  fail('bundle_analysis_identity','Analysis includes foreign plays, human review state or mismatched game identities.');
 }
 const historical=await loadGameProfileReference(path.join(modelDirectory(),'game-profiles.json'));
 const aggregate=source('nflverse-team-stats');let profiles:ReturnType<typeof normalizeGameProfiles>=[];
 if(aggregate){
  try{const rows=parseCsv(bytes.get(aggregate.snapshot.id)!);profiles=normalizeGameProfiles(bundle.game,rows);validateGameProfileFinality(bundle.game,rows,profiles,bundle.plays);}
  catch{profiles=[];}
 }
 let audit=buildGameAudit({game:bundle.game,plays:bundle.plays,profiles,reference:historical.reference,referenceChecksum:historical.checksum,events:bundle.analysis.events});
 const spread=await loadSpreadReference();
 audit.market=buildMarketAudit(bundle.game,{...schedule.snapshot,path:''},spread);
 const expected=applyExpectationsAudit(bundle.game,{...bundle.analysis,gameAudit:audit},await loadExpectationsReference());
 audit=expected.gameAudit!;
 if(stableJson(expected.models.find(model=>model.id===EXPECTATIONS_MODEL_ID))!==stableJson(bundle.analysis.models.find(model=>model.id===EXPECTATIONS_MODEL_ID)))fail('bundle_expectation_mismatch','Expectation model metadata does not match the frozen reference.');
 if(stableJson(audit)!==stableJson(bundle.analysis.gameAudit))fail('bundle_audit_mismatch','Game audit does not match the bundled sources and fixed historical reference.');
 const market=applySpreadAudit(bundle.game,bundle.analysis,[{...schedule.snapshot,path:''}],spread);
 if(stableJson(market.models.find(model=>model.id===SPREAD_MODEL_ID))!==stableJson(bundle.analysis.models.find(model=>model.id===SPREAD_MODEL_ID)))fail('bundle_market_mismatch','Market model metadata does not match the frozen reference.');
 const overtime=applyOvertimeTimeline(bundle.game,bundle.plays,bundle.analysis,await loadOvertimeReference(path.join(modelDirectory(),'overtime-reference.json')));
 if(stableJson(overtime.timeline)!==stableJson(bundle.analysis.timeline)
  ||stableJson(overtime.models.find(model=>model.id===OVERTIME_MODEL_ID))!==stableJson(bundle.analysis.models.find(model=>model.id===OVERTIME_MODEL_ID)))fail('bundle_overtime_mismatch','Overtime probabilities or model metadata do not match the immutable plays and frozen reference.');
 return {bundle,bytes};
}

/** Export statistical results only. Human adjudication and all operational tables stay local. */
export async function exportAnalysisBundle(gameId:string):Promise<AnalysisBundle>{
 assertGameId(gameId);const report=await getReport(gameId);
 if(!report)fail('bundle_report_missing','No completed report is available for export.');
 if(report.reviews.length||(await query('SELECT 1 FROM events WHERE game_id=$1 AND manual=true LIMIT 1',[gameId])).rowCount)fail('bundle_human_state','Export only freshly computed reports without manual events or reviews.');
 const sources=report.revision.sourceSnapshots;
 if(sources.some(source=>source.provider==='nflverse-raw-pbp'))fail('bundle_raw_unsupported','Run a clean-source analysis before exporting; raw RDS-derived inputs are not imported without rebuilding R.');
 const pbp=sources.filter(source=>source.provider==='nflverse-pbp');
 if(pbp.length!==1)fail('bundle_source_identity','The report does not identify exactly one clean PBP snapshot.');
 const rows=(await query('SELECT snapshot_id,play_id,provider_order,data FROM plays WHERE game_id=$1 AND snapshot_id=$2 ORDER BY provider_order',[gameId,pbp[0].id])).rows;
 if(rows.some((row,index)=>row.snapshot_id!==pbp[0].id||row.provider_order!==index||String(row.data?.play_id)!==row.play_id))fail('bundle_play_mismatch','Stored report plays do not match their snapshot and provider order.');
 const store=new LocalSnapshotStore(path.join(config.dataDir,'snapshots'));
 const snapshots:AnalysisBundle['snapshots']=[];
 const storeRoot=await realpath(store.root);
 for(const snapshot of sources){
  // A shared database can retain the original host's path after the identical
  // source is downloaded inside a container. Only the configured content store
  // is authoritative for file access; never follow that historical absolute path.
  const canonical=path.join(store.root,'snapshots',`${snapshot.checksum}.csv`);
  const resolved=await realpath(canonical);
  if(!within(storeRoot,resolved)||(await lstat(canonical)).isSymbolicLink())fail('bundle_path_rejected','Export snapshot escapes the configured source store.');
  const {path:ignoredPath,...metadata}=snapshot;const data=await store.read({...snapshot,path:canonical});
  if(data.length>MAX_SNAPSHOT_BYTES)fail('bundle_too_large','Source snapshot exceeds the 32 MiB transfer limit.');
  snapshots.push({snapshot:snapshotSchema.parse(metadata),bytesBase64:data.toString('base64')});
 }
 const payload=payloadSchema.parse({schemaVersion:1,producer:await analysisBundleProducer(),game:report.game,sourceKind:'clean',analysis:report.revision.analysis,plays:rows.map(row=>row.data),snapshots});
 const bundle={...payload,checksum:sha256(stableJson(payload))};
 await validateBundle(bundle);
 return bundle;
}

function within(root:string,file:string):boolean{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);}
async function snapshotDestination(checksum:string):Promise<string>{
 await mkdir(config.dataDir,{recursive:true});const root=await realpath(config.dataDir);
 let directory=root;
 for(const segment of ['snapshots','snapshots']){
  const next=path.join(directory,segment);
  try{const info=await lstat(next);if(info.isSymbolicLink()||!info.isDirectory())fail('bundle_path_rejected','Snapshot directory is not a regular confined directory.');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(next);}
  directory=await realpath(next);
  if(!within(root,directory))fail('bundle_path_rejected','Snapshot directory escapes the configured data directory.');
 }
 const destination=path.join(directory,`${checksum}.csv`);
 try{if((await lstat(destination)).isSymbolicLink())fail('bundle_path_rejected','Snapshot destination is a symbolic link.');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return destination;
}

/** Private operator transfer only: no network fetch, R subprocess, publication or table restore. */
export async function importAnalysisBundle(input:unknown):Promise<{gameId:string;id:string;number:number;created:boolean;bundleChecksum:string}>{
 const {bundle,bytes}=await validateBundle(input);
 const current=await getReport(bundle.game.id);
 const sourceKeys=(items:SourceSnapshot[])=>items.map(item=>`${item.provider}:${item.checksum}`).sort();
 if(current&&(stableJson(current.game)!==stableJson(bundle.game)||stableJson(current.revision.analysis)!==stableJson(bundle.analysis)
  ||stableJson(sourceKeys(current.revision.sourceSnapshots))!==stableJson(sourceKeys(bundle.snapshots.map(item=>({...item.snapshot,path:''})))))){
  fail('bundle_destination_has_report','Destination already has different report evidence; use its normal reconciliation or audit refresh.');
 }
 const known=(await query('SELECT snapshot_json FROM source_snapshots WHERE id=ANY($1::text[])',[bundle.snapshots.map(item=>item.snapshot.id)])).rows.map(row=>row.snapshot_json as SourceSnapshot);
 const snapshots:SourceSnapshot[]=[];
 for(const {snapshot} of bundle.snapshots){
  const destination=await snapshotDestination(snapshot.checksum);
  const existing=known.find(source=>source.id===snapshot.id);
  if(existing&&(existing.provider!==snapshot.provider||existing.url!==snapshot.url||existing.checksum!==snapshot.checksum||path.resolve(existing.path)!==destination)){
   fail('bundle_snapshot_conflict','An existing source identity or stored path conflicts with the imported snapshot.');
  }
  try{await writeFile(destination,bytes.get(snapshot.id)!,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(sha256(await readFile(destination))!==snapshot.checksum)fail('bundle_snapshot_conflict','An immutable destination file has conflicting content.');
  snapshots.push(existing??{...snapshot,path:destination});
 }
 const revision=await saveAnalysis(bundle.game,bundle.plays,snapshots,bundle.analysis,'clean',{expectedBaseRevisionId:current?.revision.id??null,preventPublication:true});
 return {gameId:bundle.game.id,...revision,bundleChecksum:bundle.checksum};
}
