#!/usr/bin/env node
// Deterministic offline rebuild. --refresh-officials explicitly fetches one public feed.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'csv-parse/sync';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'packages/core/reference');
const officialUrl='https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv';
const scheduleUrl='https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const aliases={'Ron Torbert':'Ronald Torbert','Bradley Rogers':'Brad Rogers','Adrian Hall':'Adrian Hill','John Perry':'John Parry','Bill Vinocich':'Bill Vinovich','Bill Carolo':'Bill Carollo','Billy Leavy':'Bill Leavy','Gene Stetatore':'Gene Steratore','Tom Corrente':'Tony Corrente','Al Riveron':'Alberto Riveron','Michael Carey':'Mike Carey','Gerry Austin':'Gerald Austin','Dick Hantag':'Dick Hantak'};
const canonical=name=>{const value=String(name??'').trim().replace(/\s+/g,' ');return aliases[value]??value;};
const output=path.join(directory,'expectations-reference.json'),officialArchive=path.join(directory,'expectations-officials.csv.gz'),officialMeta=path.join(directory,'expectations-officials-source.json');
const verify=process.argv.includes('--verify');if(verify&&process.argv.includes('--refresh-officials'))throw new Error('Verification must not refresh sources.');
if(process.argv.slice(2).some(arg=>!['--verify','--refresh-officials'].includes(arg)))throw new Error('Supported flags: --verify, --refresh-officials');
if(!verify)await mkdir(directory,{recursive:true});
let officialBytes,metadata;
if(process.argv.includes('--refresh-officials')){
 const response=await fetch(officialUrl,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Officials HTTP ${response.status}`);
 officialBytes=Buffer.from(await response.arrayBuffer());if(officialBytes.length>5_000_000)throw new Error('Unexpected officials size');
 metadata={url:officialUrl,checksum:sha(officialBytes),retrievedAt:new Date().toISOString(),lastModified:response.headers.get('last-modified'),license:'CC-BY-4.0',attribution:'nflverse'};
 await writeFile(officialArchive,gzipSync(officialBytes,{level:9}));await writeFile(officialMeta,JSON.stringify(metadata,null,2)+'\n');
}else{officialBytes=gunzipSync(await readFile(officialArchive));metadata=JSON.parse(await readFile(officialMeta,'utf8'));if(sha(officialBytes)!==metadata.checksum)throw new Error('Officials checksum mismatch');}
const profilesBytes=await readFile(path.join(root,'analytics/models/game-profiles.json'));const profiles=JSON.parse(profilesBytes);
const scheduleHash=profiles.sourceChecksums[scheduleUrl];const scheduleBytes=gunzipSync(await readFile(path.join(root,`analytics/models/game-profile-sources/${scheduleHash}.csv.gz`)));if(sha(scheduleBytes)!==scheduleHash)throw new Error('Schedule checksum mismatch');
const schedules=parse(scheduleBytes,{columns:true}),officials=parse(officialBytes,{columns:true});
const byKey=new Map();for(const r of officials.filter(r=>r.position==='Referee')){if(byKey.has(r.game_key))throw new Error(`Duplicate referee game_key ${r.game_key}`);byKey.set(r.game_key,r);}
const assignments=[];for(const g of schedules){
 if(Number(g.season)>2026||Number(g.season)<1999)continue;
 const o=byKey.get(g.gsis),scheduleName=canonical(g.referee),officialName=canonical(o?.official_name);
 if(o&&Number(o.season)!==Number(g.season))throw new Error('Official season mismatch');
 const conflict=!!(o&&scheduleName&&officialName&&scheduleName!==officialName);
 const name=conflict?null:(scheduleName||officialName||null);
 const status=conflict?'conflict':o&&officialName?'verified':scheduleName?'schedule_only':'missing';
 if(Number(g.season)>2025&&!scheduleName&&!officialName)continue;
 assignments.push({gameId:g.game_id,season:Number(g.season),name,canonicalId:name?name.toLowerCase().replace(/[^a-z0-9]+/g,'-'):null,status,scheduleName:g.referee||null,officialName:o?.official_name||null,officialId:o?.official_id||null,officialEra:o?(Number(o.season)>=2023?'2023+':'2015-2022'):null});
}
const byGame=new Map();for(const p of profiles.rows){const pair=byGame.get(p.gameId)??[];pair.push(p);byGame.set(p.gameId,pair);}
const rows=[],exclusions=[];
for(const g of schedules.filter(g=>Number(g.season)>=1999&&Number(g.season)<=2025&&g.game_type==='REG')){
 const pair=byGame.get(g.game_id),h=pair?.find(p=>p.team===g.home_team),a=pair?.find(p=>p.team===g.away_team);
 if(!h||!a||pair.length!==2){exclusions.push({gameId:g.game_id,reason:'paired_profiles_missing'});continue;}
 if(h.pointsFor!==a.pointsAgainst||a.pointsFor!==h.pointsAgainst||h.turnoverMargin!==-a.turnoverMargin||h.totalYards!==a.opponentYards||a.totalYards!==h.opponentYards)throw new Error('Inconsistent paired reference');
 rows.push({gameId:g.game_id,season:Number(g.season),homeTeam:g.home_team,awayTeam:g.away_team,homeScore:h.pointsFor,awayScore:a.pointsFor,homeYards:h.totalYards,awayYards:a.totalYards,homeTurnoverMargin:h.turnoverMargin,homePenalties:h.penalties,awayPenalties:a.penalties,homePenaltyYards:h.penaltyYards,awayPenaltyYards:a.penaltyYards});
}
const sourceMetadata=[...profiles.sources,metadata];
const value={schemaVersion:1,version:'under-review-expectations-reference-v1',startSeason:1999,endSeason:2025,rows,assignments,aliases,
 sourceUrls:sourceMetadata.map(s=>s.url),sourceChecksums:Object.fromEntries(sourceMetadata.map(s=>[s.url,s.checksum])),sources:sourceMetadata,
 inputProfileChecksum:sha(profilesBytes),license:'CC-BY-4.0',exclusions,
 notes:['Only regular-season team-game observations enter model fitting and calibration. The target season is never used.',
 'Officials game_key joins schedule gsis. Date-form game_id is not used because it reindexes for postponed games.',
 'official_id changes namespace in 2023; explicit canonical names and documented aliases identify head referees, not stable full crews. Conflicting assignments are excluded from referee-specific cohorts.',
 'Officials assignments are not individual flag attribution or measures of correctness. No-call detection and private league officiating grades are unavailable.',
 'Derived from nflverse/nflfastR and Lee Sharpe schedules under CC BY 4.0; transformations: REG filtering, paired-team projection, referee joins and conflict/alias handling.',
 'Older historical statistics reflect the frozen provider revision, not an archived pregame publication vintage. No outcome from the target or later seasons enters estimation.']};
const built=Buffer.from(JSON.stringify(value)+'\n');
if(verify){if(!(await readFile(output)).equals(built))throw new Error('Offline rebuilt expectations reference differs from the frozen file.');}
else await writeFile(output,built);
console.log(JSON.stringify({file:'packages/core/reference/expectations-reference.json',verified:verify,games:rows.length,assignments:assignments.length,conflicts:assignments.filter(a=>a.status==='conflict').length,checksum:sha(built)}));
