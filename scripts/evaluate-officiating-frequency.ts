import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fitFrequencyModel,frequencyDiagnostics,type FrequencyGame} from '../packages/core/src/officiating-frequency.js';
import {readOfficiatingCorpus} from './lib/officiating-sources.js';

// Development only. Final 2024/2025 evaluations are a separate frozen step.
const seasons=Array.from({length:9},(_,i)=>2015+i),games:FrequencyGame[]=await readOfficiatingCorpus(process.cwd(),seasons),hashes:Record<string,string>={};
for(const season of seasons){
  const file=`data/officiating-corpus/season-${season}.json.gz`,bytes=await readFile(file);
  hashes[String(season)]=createHash('sha256').update(bytes).digest('hex');
}
await mkdir('data/officiating-evaluation',{recursive:true});
const result:Record<string,unknown>[]=[];
for(const prior of [50,200,1000])for(const year of [2021,2022,2023]){
  const model=fitFrequencyModel(year,games,prior),test=games.filter(g=>g.observation.season===year);
  const modes=Object.fromEntries((['league','team','context','crew'] as const).map(mode=>[mode,frequencyDiagnostics(model,test,mode)]));
  const row={year,prior,trainingGames:model.games,testGames:test.length,modes};result.push(row);
  console.log(JSON.stringify({year,prior,trainingGames:model.games,testGames:test.length,loss:Object.fromEntries(Object.entries(modes).map(([key,d])=>[key,d.logLoss]))}));
}
await writeFile('data/officiating-evaluation/stage1-frequency.json',JSON.stringify({version:1,purpose:'development; excludes 2024 onward',hashes,results:result},null,2)+'\n');
