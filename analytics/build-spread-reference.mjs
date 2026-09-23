#!/usr/bin/env node
/** Offline derivation from the checksum-verified schedule archive already shipped with game profiles. */
import { readFile,writeFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseCsv,numberOrNull,sha256 } from './build-game-profiles.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function buildSpreadReference(){
 const profile=JSON.parse(await readFile(resolve(root,'analytics/models/game-profiles.json'),'utf8'));
 const source=profile.sources.find(s=>s.url==='https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv');
 if(!source||!/^[a-f0-9]{64}\.csv\.gz$/.test(source.archive))throw new Error('Missing fixed schedule source.');
 const bytes=gunzipSync(await readFile(resolve(root,'analytics/models/game-profile-sources',source.archive)));
 if(sha256(bytes)!==source.checksum)throw new Error('Schedule archive checksum mismatch.');
 const rows=[],seen=new Set(),exclusions={missingLine:0,missingScore:0};
 for(const row of parseCsv(bytes,['game_id','season','game_type','spread_line','home_score','away_score','result'])){
  const season=numberOrNull(row.season);
  if(season===null||season<1999||season>2025||!['REG','WC','DIV','CON','SB'].includes(row.game_type))continue;
  if(seen.has(row.game_id))throw new Error('Duplicate historical schedule game.');seen.add(row.game_id);
  const line=numberOrNull(row.spread_line),home=numberOrNull(row.home_score),away=numberOrNull(row.away_score),result=numberOrNull(row.result);
  if(home===null||away===null||!Number.isInteger(home)||!Number.isInteger(away)||home<0||away<0||result!==home-away){exclusions.missingScore++;continue;}
  if(line===null){exclusions.missingLine++;continue;}
  if(!Number.isInteger(season)||!row.game_id.startsWith(`${season}_`)||Math.abs(line)>100||!Number.isInteger(line*2))throw new Error('Invalid historical spread row.');
  rows.push([row.game_id,season,line,home,away]);
 }
 rows.sort((a,b)=>a[0].localeCompare(b[0]));
 const artifact={schemaVersion:1,version:'nflverse-spread-reference-v1',startSeason:1999,endSeason:2025,
  source:{url:source.url,checksum:source.checksum,retrievedAt:source.retrievedAt,license:'CC-BY-4.0',archive:`game-profile-sources/${source.archive}`},
  columns:['gameId','season','expectedHomeMargin','homeScore','awayScore'],rows,
  coverage:{games:rows.length,exclusions,seasons:Array.from({length:27},(_,i)=>({season:1999+i,games:rows.filter(row=>row[1]===1999+i).length}))},
  notes:['Source: Lee Sharpe / nflverse schedules; CC BY 4.0. Derived field selection and inclusive 1999–2025 season filtering.',
   'Use only seasons strictly before the target season. Missing line is excluded; observed zero is pick’em.',
   'One row per completed regular-season or postseason game. Final scores include overtime.',
   'Historical absolute final-margin errors are descriptive and pooled across eras and game types; this is not a manipulation model.'],
  rowsChecksum:sha256(JSON.stringify(rows))};
 await writeFile(resolve(root,'analytics/models/spread-reference.json'),`${JSON.stringify(artifact)}\n`);
 return artifact;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await buildSpreadReference();console.log(JSON.stringify({games:result.rows.length,coverage:result.coverage,rowsChecksum:result.rowsChecksum,sourceChecksum:result.source.checksum}));
}
