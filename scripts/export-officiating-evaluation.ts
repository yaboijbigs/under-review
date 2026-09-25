import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Public derived statistics only. Raw caches and operational files stay local.
const read=async(name:string)=>JSON.parse(await readFile(`data/officiating-evaluation/${name}.json`,'utf8'));
const [impact,summary,stability]=await Promise.all([read('impact-2026'),read('summary-2026'),read('stability-2026')]);
const reference=await readFile('packages/core/reference/officiating-reference.json');
const result={schemaVersion:1,status:'experimental-release-blocked',referenceChecksum:createHash('sha256').update(reference).digest('hex'),
 selection:impact.selection,provenance:impact.provenance,seasons:summary.seasons,
 diagnostics:impact.diagnostics.map((d:any)=>({year:d.year,games:d.games,trainingGames:d.trainingGames,ep:d.ep,wp:d.wp,epBins:d.epBins,
  frequency:{logLoss:d.frequency.logLoss,leagueLogLoss:d.leagueFrequency.logLoss,teamLogLoss:d.teamFrequency.logLoss,crewLogLoss:d.crewFrequency.logLoss,actual:d.frequency.calls,expected:d.frequency.expectedCalls}})),
 crewDirectionRepeatability:impact.crewDirectionRepeatability,currentGames:summary.games.filter((g:any)=>g.season===2026),stability:{...stability,input:'data/officiating-evaluation/impact-2026.json'}};
await writeFile('benchmarks/officiating/results.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,currentGames:result.currentGames.length,referenceChecksum:result.referenceChecksum}));
