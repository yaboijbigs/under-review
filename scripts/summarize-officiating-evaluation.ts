import {readFile,writeFile} from 'node:fs/promises';
import {calibrationGame,calibrateImpact} from '../packages/core/src/officiating-calibration.js';
import {impactCoverageReason,officiatingTier} from '../packages/core/src/officiating-contracts.js';
import {readOfficiatingCorpus} from './lib/officiating-sources.js';
import {buildBaseline} from './lib/officiating-baseline.js';
import type {GameImpactResult} from '../packages/core/src/officiating-impact.js';
import type {Game} from '../packages/core/src/contracts.js';

const through=Number(process.argv.find(a=>a.startsWith('--through='))?.split('=')[1]??2023);
if(![2023,2025,2026].includes(through))throw new Error('Invalid evaluation cutoff.');
const directory='data/officiating-evaluation',input=JSON.parse(await readFile(`${directory}/impact-${through}.json`,'utf8'));
const predictions=input.predictions as (GameImpactResult&{match:Game})[],history=predictions.map(calibrationGame).filter(g=>g!==null);
const corpus=await readOfficiatingCorpus(process.cwd(),Array.from({length:through-2023+1},(_,i)=>2023+i));
const baseline=await buildBaseline(corpus);
const games=predictions.filter(g=>g.season>=2023).map(g=>{
  const calibration=calibrateImpact(g,history),old=baseline[g.gameId],reason=impactCoverageReason(g);
  const rating=calibration.tailProbability===null?null:officiatingTier(calibration.tailProbability),gameOnly=calibration.gameTailProbability===null?null:officiatingTier(calibration.gameTailProbability);
  return {id:g.gameId,season:g.season,rating,gameOnly,oldRating:old?.rating??null,oldReason:old?.reason??null,oldDriveCount:old?.driveCount??0,
    reason:reason??(rating===null?'insufficient_calibration':null),calibration,strongest:g.strongest,favoredTeam:g.favoredTeam,
    maximum:g.maximum,game:g.game,drive:g.drives[0]??null,coverage:g.coverage,events:g.events};
});
const seasons=[...new Set(games.map(g=>g.season))].map(season=>{
  const rows=games.filter(g=>g.season===season),distribution=(key:'rating'|'oldRating'|'gameOnly')=>Object.fromEntries([null,1,2,3,4,5].map(level=>[String(level),rows.filter(g=>g[key]===level).length]));
  return {season,games:rows.length,ratings:distribution('rating'),wholeGameOnly:distribution('gameOnly'),oldRatings:distribution('oldRating'),
    changed:rows.filter(g=>g.rating!==g.oldRating).length,driveSearchChangedTier:rows.filter(g=>g.rating!==g.gameOnly).length,
    valuedPenalties:rows.reduce((n,g)=>n+g.coverage.valuedPenalties,0),acceptedPenalties:rows.reduce((n,g)=>n+g.coverage.acceptedPenalties,0),
    reasons:Object.fromEntries([...new Set(rows.map(g=>g.reason).filter(Boolean))].map(reason=>[reason,rows.filter(g=>g.reason===reason).length]))};
});
const output={through,provenance:input.provenance,selection:input.selection,seasons,games,crewDirectionRepeatability:input.crewDirectionRepeatability};
await writeFile(`${directory}/summary-${through}.json`,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({seasons,crewDirectionRepeatability:input.crewDirectionRepeatability,highest:games.filter(g=>(g.rating??0)>=4).sort((a,b)=>b.maximum-a.maximum).slice(0,10).map(g=>({id:g.id,rating:g.rating,old:g.oldRating,maximum:g.maximum,strongest:g.strongest,events:g.events.map(e=>({playId:e.playId,type:e.type,homeEp:e.homeEp}))}))},null,2));
