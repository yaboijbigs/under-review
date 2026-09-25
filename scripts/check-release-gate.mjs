import {readFile} from 'node:fs/promises';
const gate=JSON.parse(await readFile(new URL('../benchmarks/officiating/release-gate.json',import.meta.url),'utf8'));
if(gate.schemaVersion!==1||gate.status!=='ready'){
 console.error(`Container publication blocked for ${gate.candidate}:\n${gate.reasons.map(r=>`- ${r}`).join('\n')}`);
 process.exitCode=1;
}
