import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readOfficiatingCorpus} from './lib/officiating-sources.js';
import {fitFrequencyModel,frequencyDiagnostics,crewRepeatability} from '../packages/core/src/officiating-frequency.js';
import {fitStateModel,estimateState,estimateStateBaseline} from '../packages/core/src/officiating-state-model.js';
import {fitImpactModel,calculateGameImpact} from '../packages/core/src/officiating-impact.js';

const arg=process.argv.find(a=>a.startsWith('--through=')),through=arg?Number(arg.split('=')[1]):2023;
if(![2023,2025,2026].includes(through))throw new Error('Use --through=2023 for development, 2025 for held-out evaluation, or 2026 for release.');
const directory='data/officiating-evaluation';await mkdir(directory,{recursive:true});
const selection=JSON.parse(await readFile(`${directory}/selection.json`,'utf8')) as {prior:number;crewAdjustment:boolean};
const years=Array.from({length:through-2015+1},(_,i)=>2015+i);
const corpusManifest=async()=>Object.fromEntries(await Promise.all(years.map(async year=>[String(year),JSON.parse(await readFile(`data/officiating-corpus/season-${year}.metadata.json`,'utf8')).checksum])));
const codeManifest=async()=>Object.fromEntries(await Promise.all(['officiating-observations','officiating-frequency','officiating-state-model','officiating-impact'].map(async name=>[name,createHash('sha256').update(await readFile(`packages/core/src/${name}.ts`)).digest('hex')])));
const corpusChecksums=await corpusManifest(),provenance=await codeManifest();
const corpus=await readOfficiatingCorpus(process.cwd(),years);
if(JSON.stringify(corpusChecksums)!==JSON.stringify(await corpusManifest()))throw new Error('Corpus changed while loading evaluation inputs.');
const observations=corpus.map(g=>g.observation),models:Record<string,unknown>={},predictions:any[]=[],diagnostics:any[]=[];
for(let year=2020;year<=through;year++){
  const training=corpus.filter(g=>g.game.season<year&&g.game.season>=year-5),test=corpus.filter(g=>g.game.season===year);
  const frequency=fitFrequencyModel(year,training,selection.prior),state=fitStateModel(year,training.map(g=>g.observation)),impact=fitImpactModel(year,training,state);
  models[year]={frequency,state,impact};
  let epN=0,epError=0,epBaselineError=0,wpN=0,wpError=0,wpBaselineError=0,wpScoreClockError=0;
  const wpBins=Array.from({length:10},()=>({n:0,predicted:0,actual:0}));
  const epBins=Array.from({length:7},()=>({n:0,predicted:0,actual:0}));
  const stateByGame:{gameId:string;epN:number;epError:number;epBaselineError:number;wpN:number;wpError:number;wpScoreClockError:number}[]=[];
  const exclusions:Record<string,number>={};
  for(const entry of test){const g=entry.observation;
    const gd={gameId:g.gameId,epN:0,epError:0,epBaselineError:0,wpN:0,wpError:0,wpScoreClockError:0};
    const result=calculateGameImpact(g,frequency,state,impact,selection.crewAdjustment?'crew':'context',entry.crewStatus==='conflict'?[]:entry.crew);
    predictions.push({match:entry.game,crew:entry.crew,crewStatus:entry.crewStatus,...result});
    for(const o of g.opportunities){const predicted=estimateState(state,o.state,g.homeTeam),baseline=estimateStateBaseline(state,o.state,g.homeTeam);
      if(o.labels.nextScore!==null&&predicted.ep!==null&&baseline.ep!==null){epN++;epError+=(predicted.ep-o.labels.nextScore)**2;epBaselineError+=(baseline.ep-o.labels.nextScore)**2;
        gd.epN++;gd.epError+=(predicted.ep-o.labels.nextScore)**2;gd.epBaselineError+=(baseline.ep-o.labels.nextScore)**2;
        const bin=epBins[Math.min(6,Math.floor((predicted.ep+7)/2))];bin.n++;bin.predicted+=predicted.ep;bin.actual+=o.labels.nextScore;
      }
      else exclusions[predicted.reasonCode??'missing_label']=(exclusions[predicted.reasonCode??'missing_label']??0)+1;
      if(o.labels.homeWin!==null&&predicted.homeWp!==null&&baseline.homeWp!==null&&baseline.scoreClockHomeWp!==null){
        wpN++;wpError+=(predicted.homeWp-o.labels.homeWin)**2;wpBaselineError+=(baseline.homeWp-o.labels.homeWin)**2;wpScoreClockError+=(baseline.scoreClockHomeWp-o.labels.homeWin)**2;
        gd.wpN++;gd.wpError+=(predicted.homeWp-o.labels.homeWin)**2;gd.wpScoreClockError+=(baseline.scoreClockHomeWp-o.labels.homeWin)**2;
        const bin=wpBins[Math.min(9,Math.floor(predicted.homeWp*10))];bin.n++;bin.predicted+=predicted.homeWp;bin.actual+=o.labels.homeWin;
      }
    }
    stateByGame.push(gd);
  }
  const d={year,games:test.length,trainingGames:training.length,ep:{n:epN,rmse:epN?Math.sqrt(epError/epN):null,baselineRmse:epN?Math.sqrt(epBaselineError/epN):null},wp:{n:wpN,brier:wpN?wpError/wpN:null,constantBrier:wpN?wpBaselineError/wpN:null,scoreClockBrier:wpN?wpScoreClockError/wpN:null,bins:wpBins.map(b=>({...b,predicted:b.n?b.predicted/b.n:null,actual:b.n?b.actual/b.n:null}))},exclusions,frequency:frequencyDiagnostics(frequency,test,'context'),crewFrequency:frequencyDiagnostics(frequency,test.filter(g=>g.crewStatus!=='conflict'),'crew')};
  diagnostics.push({...d,stateByGame,epBins:epBins.map(b=>({...b,predicted:b.n?b.predicted/b.n:null,actual:b.n?b.actual/b.n:null})),leagueFrequency:frequencyDiagnostics(frequency,test,'league'),teamFrequency:frequencyDiagnostics(frequency,test,'team')});console.log(JSON.stringify({year,games:test.length,ep:d.ep,wp:{n:wpN,brier:d.wp.brier,scoreClockBrier:d.wp.scoreClockBrier},valuedPenalties:predictions.filter(g=>g.season===year).reduce((n,g)=>n+g.coverage.valuedPenalties,0),stateConverged:{ep:state.ep.converged,wp:state.wp.converged}}));
}
const early=fitFrequencyModel(2020,corpus.filter(g=>g.game.season<=2018),selection.prior),late=fitFrequencyModel(2024,corpus.filter(g=>g.game.season>=2019&&g.game.season<=2023),selection.prior);
if(JSON.stringify(corpusChecksums)!==JSON.stringify(await corpusManifest())||JSON.stringify(provenance)!==JSON.stringify(await codeManifest()))throw new Error('Corpus or model code changed during evaluation.');
await writeFile(`${directory}/impact-${through}.json`,JSON.stringify({schemaVersion:1,through,selection,provenance,corpusChecksums,models,predictions,diagnostics,crewDirectionRepeatability:crewRepeatability(early,late)})+'\n');
