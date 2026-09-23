import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { config,projectRoot } from '../packages/core/src/config.js';
import { gameSchema,type AnalysisResult,type Game,type SourceSnapshot } from '../packages/core/src/contracts.js';
import type { ProviderRow } from '../packages/core/src/normalize.js';
import { getGameVerdict } from '../packages/core/src/consumer-summary.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { loadGameProfileReference } from '../packages/core/src/game-profile-source.js';
import { loadExpectationsReference } from '../packages/core/src/expectations.js';
import { applyExpectationsAudit } from '../packages/core/src/expectations-integration.js';
import { applySpreadAudit,loadSpreadReference } from '../packages/core/src/spread.js';
import { loadOfficiatingReference } from '../packages/core/src/officiating-reference.js';
import { applyOfficiatingAudit } from '../packages/core/src/officiating-integration.js';
import { validOfficiatingAudit } from '../packages/core/src/officiating-contracts.js';

// This fixture is intentionally unusable against a deployed database.
const database=new URL(config.databaseUrl),site=new URL(config.siteUrl);
if(process.env.CI!=='true'||!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/under_review_ci'||!['127.0.0.1','localhost'].includes(site.hostname)||process.env.LIVE_POSTING_ALLOWED!=='false')throw new Error('Browser fixtures require the isolated loopback under_review_ci database and disabled publishing.');

// Use an actual frozen result and strictly earlier historical data. This isolated
// UI fixture deliberately supplies no fabricated plays, events or WP estimates.
const id='2025_12_MIN_GB';
const [profiles,expectations,spread]=await Promise.all([
 loadGameProfileReference(path.join(projectRoot,'analytics/models/game-profiles.json')),
 loadExpectationsReference(),
 loadSpreadReference()
]);
const row=expectations.reference.rows.find(item=>item.gameId===id);
const line=spread.reference.rows.find(item=>item[0]===id);
const assignment=expectations.reference.assignments.find(item=>item.gameId===id);
if(!row||!line||row.homeScore===null||row.awayScore===null||line[3]!==row.homeScore||line[4]!==row.awayScore)throw new Error('The frozen browser result is missing or inconsistent.');
const game:Game={id,season:row.season,week:12,gameType:'REG',homeTeam:row.homeTeam,awayTeam:row.awayTeam,homeScore:row.homeScore,awayScore:row.awayScore,kickoffAt:'2025-11-23T18:00:00.000Z',providerData:{ciFixture:true,spread_line:line[2],result:row.homeScore-row.awayScore,referee:assignment?.scheduleName??null}};
const source=spread.reference.source;
const scheduleSnapshot:SourceSnapshot={id:'ci-frozen-schedule-'+source.checksum,provider:'nflverse-schedules',url:source.url,checksum:source.checksum,retrievedAt:source.retrievedAt,path:path.join(projectRoot,'analytics/models',source.archive),license:source.license,metadata:{ciFixture:true,notes:'Actual saved schedule row extracted from the frozen reference; no live data was fetched.'}};
const profileSnapshot:SourceSnapshot={id:'ci-frozen-profiles-'+profiles.checksum,provider:'ci-frozen-game-profiles',url:'https://github.com/yaboijbigs/under-review/blob/main/analytics/models/game-profiles.json',checksum:profiles.checksum,retrievedAt:source.retrievedAt,path:path.join(projectRoot,'analytics/models/game-profiles.json'),license:'CC-BY-4.0',metadata:{ciFixture:true,notes:'Actual paired statistics from the checked-in frozen profile artifact. This UI fixture omits play-by-play.'}};
const snapshots=[profileSnapshot,scheduleSnapshot];
const beforeAudit:AnalysisResult={schemaVersion:1,metrics:[],events:[],timeline:[],coverage:[],models:[],warnings:['Isolated CI report fixture from frozen historical statistics; play-by-play is intentionally absent.']};
const legacy=applySpreadAudit(game,{...beforeAudit,gameAudit:buildGameAudit({game,profiles:profiles.reference.rows.filter(item=>item.gameId===id),reference:profiles.reference,referenceChecksum:profiles.checksum})},snapshots,spread);
const version5=applyExpectationsAudit(game,legacy,expectations);
const verdict=getGameVerdict(version5.gameAudit);
if(verdict.rating===null||verdict.rulesVersion!=='game-suspicion-v3'||getGameVerdict(legacy.gameAudit).rulesVersion!=='game-suspicion-v2')throw new Error('The fixture must retain a legacy rating and produce a supported current rating from real frozen data.');
if(version5.gameAudit?.expectations?.outcome.status!=='supported'||version5.gameAudit.expectations.penalty.status!=='supported'||!version5.gameAudit.expectations.referee.games)throw new Error('The fixture must expose supported performance, penalty and referee comparisons.');

// The candidate revision uses the real public schedule and every recorded play.
// Its source file is a game extract, so retain both its own hash and the parent CSV hash.
const fixturePath=path.join(projectRoot,'tests/fixtures/officiating-game.json'),fixtureBytes=await readFile(fixturePath);
const fixture=JSON.parse(fixtureBytes.toString('utf8')) as {schemaVersion:number;game:Game;plays:ProviderRow[];sources:{playByPlay:{url:string;checksum:string;license:string};schedule:{url:string;checksum:string;license:string}}};
const candidateGame=gameSchema.parse(fixture.game),candidatePlays=fixture.plays;
if(fixture.schemaVersion!==1||candidateGame.id!==id||candidateGame.homeScore!==game.homeScore||candidateGame.awayScore!==game.awayScore||candidateGame.kickoffAt!==game.kickoffAt||fixture.sources.schedule.checksum!==scheduleSnapshot.checksum||!Array.isArray(candidatePlays)||!candidatePlays.length)throw new Error('The public candidate fixture does not match the frozen game and schedule.');
const fixtureChecksum=createHash('sha256').update(fixtureBytes).digest('hex');
const playSnapshot:SourceSnapshot={id:'ci-frozen-game-pbp-'+fixtureChecksum,provider:'ci-frozen-game-pbp',url:'https://github.com/yaboijbigs/under-review/blob/main/tests/fixtures/officiating-game.json',checksum:fixtureChecksum,retrievedAt:source.retrievedAt,path:fixturePath,license:fixture.sources.playByPlay.license,metadata:{ciFixture:true,sourceUrl:fixture.sources.playByPlay.url,sourceChecksum:fixture.sources.playByPlay.checksum,notes:'Actual public game extract. Snapshot checksum identifies the extract; sourceChecksum identifies its parent play-by-play CSV.'}};
const candidateSnapshots=[...snapshots,playSnapshot],officiating=await loadOfficiatingReference();
const candidateBase:AnalysisResult={...beforeAudit,warnings:['Isolated CI candidate from real frozen schedule, paired statistics and play-by-play; no fabricated plays or forecasts.'],gameAudit:buildGameAudit({game:candidateGame,plays:candidatePlays,profiles:profiles.reference.rows.filter(item=>item.gameId===id),reference:profiles.reference,referenceChecksum:profiles.checksum})};
const candidate=applyOfficiatingAudit(candidateGame,candidatePlays,applyExpectationsAudit(candidateGame,applySpreadAudit(candidateGame,candidateBase,candidateSnapshots,spread),expectations),officiating);
const candidateVerdict=getGameVerdict(candidate.gameAudit),candidateAudit=candidate.gameAudit?.officiating;
if(candidateVerdict.rating!==2||candidateVerdict.rulesVersion!=='game-suspicion-v4'||!validOfficiatingAudit(candidateAudit)||candidateAudit?.crew.status!=='complete'||candidateAudit.crew.roles.length!==7)throw new Error('The real candidate must reproduce Debatable 2/5 with valid enforcement evidence and a complete crew.');

if(process.argv.includes('--validate-only')){
 console.log('Validated frozen 2025_12_MIN_GB: pre-audit, v2 and v3 legacy rules, candidate v4 Debatable 2/5, seven-role crew, checksummed reference and real play extract; no database opened.');
}else{
 const {migrate,pool}=await import('../packages/core/src/db.js');
 try{
  await migrate();
  const {saveAnalysis}=await import('../packages/core/src/repository.js');
  await saveAnalysis(game,[],snapshots,beforeAudit,'clean',{preventPublication:true});
  await saveAnalysis(game,[],snapshots,legacy,'clean',{preventPublication:true});
  await saveAnalysis(game,[],snapshots,version5,'clean',{preventPublication:true});
  await saveAnalysis(candidateGame,candidatePlays,candidateSnapshots,candidate,'clean',{preventPublication:true});
  console.log('Seeded non-publishable CI revisions for 2025_12_MIN_GB: 1 pre-audit, 2 v2 rules, 3 v3 rules, 4 experimental v4. No invented plays or forecasts.');
 }finally{await pool.end();}
}
