import { parseArgs } from 'node:util';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { config,projectRoot,safeError } from '@under-review/core/config';
import { migrate,pool,query } from '@under-review/core/db';
import { createUser } from '@under-review/core/auth';
import { analyzeGame,syncSeason } from '@under-review/core/pipeline';
import { createDraft } from '@under-review/core/publishing';
import { runRRequest } from '@under-review/core/analytics-bridge';
import { getOperationalStatus } from '@under-review/core/repository';
import { getSeasonCoverage,queueSeasonCatchup,validateCoverageScope } from '@under-review/core/season-coverage';
import { exportAnalysisBundle,importAnalysisBundle,MAX_ANALYSIS_BUNDLE_BYTES } from '@under-review/core/analysis-bundle';

const {positionals,values}=parseArgs({allowPositionals:true,options:{season:{type:'string'},weeks:{type:'string'},game:{type:'string'},backfill:{type:'boolean'},clean:{type:'boolean'},username:{type:'string'},role:{type:'string'},input:{type:'string'},output:{type:'string'},confirm:{type:'boolean'}}});
const command=positionals[0];
try{
 let result:unknown;
 switch(command){
  case 'migrate':await migrate();result={migrated:true};break;
  case 'doctor':result={...await getOperationalStatus(),analyticsScript:path.join(projectRoot,'analytics/run.R'),livePostingAllowed:config.livePostingAllowed,siteUrl:config.siteUrl};break;
  case 'sync-season':result=await syncSeason(Number(values.season??config.season),false);break;
  case 'export-analysis':{
   if(!values.game||!values.output)throw new Error('--game and --output are required');
   const bundle=await exportAnalysisBundle(values.game);
   await mkdir(path.dirname(path.resolve(values.output)),{recursive:true});
   await writeFile(values.output,JSON.stringify(bundle));
   result={gameId:values.game,output:values.output,checksum:bundle.checksum};break;
  }
  case 'import-analysis':{
   if(!values.input)throw new Error('--input is required');
   const bytes=await readFile(values.input);if(bytes.length>MAX_ANALYSIS_BUNDLE_BYTES)throw new Error('Analysis bundle exceeds its transfer limit.');
   result=await importAnalysisBundle(JSON.parse(bytes.toString('utf8')));break;
  }
  case 'coverage':case 'catch-up':{
   const season=Number(values.season??config.season);
   const weeks=validateCoverageScope(season,values.weeks?.split(',').map(Number)??[]);
   if(command==='catch-up'){await syncSeason(season,false);result=await queueSeasonCatchup(season,weeks);}
   else result={season,weeks,games:await getSeasonCoverage(season,weeks)};
   break;
  }
  case 'analyze-game':if(!values.game)throw new Error('--game is required');result=await analyzeGame(values.game,{backfill:values.backfill,preferRaw:!values.clean});break;
  case 'draft':if(!values.game)throw new Error('--game is required');result=await createDraft(values.game);break;
  case 'backfill':case 'reconcile':{
   if(process.env.VPS_STAGING==='true'&&!values.confirm)throw new Error('Bulk processing is disabled on the shared VPS unless explicitly invoked with --confirm; train and backfill locally.');
   const season=Number(values.season??config.season);await syncSeason(season,false);
   const games=(await query("SELECT id FROM games WHERE season=$1 AND (game_json->>'homeScore') IS NOT NULL ORDER BY kickoff_at",[season])).rows;
   const outcomes=[];for(const game of games){try{outcomes.push(await analyzeGame(game.id,{backfill:true,preferRaw:false}));}catch(error){outcomes.push({gameId:game.id,error:safeError(error)});}}
   result={outcomes};break;
  }
  case 'admin:create':{
   const rl=createInterface({input:process.stdin,output:process.stdout});
   try{const username=values.username??await rl.question('Username: ');const password=process.env.UR_ADMIN_PASSWORD??await rl.question('Password (at least 14 characters; local console input): ');result={userId:await createUser(username,password,values.role==='reviewer'?'reviewer':'admin')};}finally{rl.close();}break;
  }
  case 'train':case 'calibrate':case 'evaluate':case 'percentiles':{
   if(process.env.VPS_STAGING==='true')throw new Error('Historical model training/evaluation runs off the shared VPS.');
   if(!values.input)throw new Error('--input JSON manifest is required');
   const payload=JSON.parse(await readFile(values.input,'utf8'));
   result=await runRRequest({...payload,schemaVersion:1,action:command},{scriptPath:path.join(projectRoot,'analytics/run.R'),timeoutMs:3600000,maxOutputBytes:64*1024*1024});
   if(values.output){await mkdir(path.dirname(path.resolve(values.output)),{recursive:true});await writeFile(values.output,JSON.stringify(result,null,2));}break;
  }
  default:result={commands:['migrate','doctor','sync-season --season 2026','coverage --season 2026 --weeks 1,2','catch-up --season 2026 --weeks 1,2','analyze-game --game 2026_01_NE_SEA [--backfill] [--clean]','backfill --season 2023','reconcile --season 2026','draft --game 2026_01_NE_SEA','admin:create','train|calibrate|evaluate|percentiles --input manifest.json --output result.json']};
 }
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:safeError(error)}));process.exitCode=1;}finally{await pool.end();}
