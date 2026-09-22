import { readdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import { importAnalysisBundle,AnalysisBundleError,MAX_ANALYSIS_BUNDLE_BYTES } from '@under-review/core/analysis-bundle';
import { queueSeasonCatchup } from '@under-review/core/season-coverage';
import { createDraft } from '@under-review/core/publishing';
import { pool } from '@under-review/core/db';
import { config,safeError } from '@under-review/core/config';

try{
 if(config.livePostingAllowed)throw new Error('Catch-up import requires live posting to remain disabled.');
 const directory=process.argv[2]??'/imports';
 const files=(await readdir(directory)).filter(name=>/^2026_0[12]_[A-Z]{2,3}_[A-Z]{2,3}\.json$/.test(name)).sort();
 if(!files.length||files.length>32)throw new Error('Expected one to32 report bundles for the requested two regular-season weeks.');
 for(const file of files){
  const bytes=await readFile(path.join(directory,file));if(bytes.length>MAX_ANALYSIS_BUNDLE_BYTES)throw new Error('Bundle exceeds its transfer limit.');
  const bundle=JSON.parse(bytes.toString('utf8'));const gameId=file.slice(0,-5);
  if(bundle.game?.id!==gameId)throw new Error('Bundle filename and game identity differ.');
  try{
   const result=await importAnalysisBundle(bundle);await createDraft(gameId);
   console.log(JSON.stringify({event:'catchup.imported',...result}));
  }catch(error){
   if(error instanceof AnalysisBundleError&&error.code==='bundle_destination_has_report'){
    console.log(JSON.stringify({event:'catchup.preserved_existing_report',gameId}));continue;
   }
   throw error;
  }
 }
 const catchup=await queueSeasonCatchup(2026,[1,2]);
 console.log(JSON.stringify({event:'catchup.import.complete',bundles:files.length,queued:catchup.queued,coverage:catchup.games}));
}catch(error){console.error(JSON.stringify({event:'catchup.import.failed',error:safeError(error)}));process.exitCode=1;}finally{await pool.end();}
