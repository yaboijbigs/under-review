import { config } from '../packages/core/src/config.js';
import type { AnalysisResult,Game,GameProfile,GameProfileReference,SourceSnapshot } from '../packages/core/src/contracts.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { buildMarketAudit,loadSpreadReference } from '../packages/core/src/spread.js';
import { sourceUrls } from '../packages/core/src/sources.js';

// This fixture is intentionally unusable against a deployed database.
const database=new URL(config.databaseUrl),site=new URL(config.siteUrl);
if(process.env.CI!=='true'||!['127.0.0.1','localhost'].includes(database.hostname)||database.pathname!=='/under_review_ci'||!['127.0.0.1','localhost'].includes(site.hostname)||process.env.LIVE_POSTING_ALLOWED!=='false')throw new Error('Browser fixtures require the isolated loopback under_review_ci database and disabled publishing.');

const game:Game={id:'2099_01_GB_MIN',season:2099,week:1,gameType:'REG',homeTeam:'MIN',awayTeam:'GB',homeScore:17,awayScore:21,kickoffAt:'2099-09-01T17:00:00.000Z',providerData:{synthetic:true,spread_line:3,result:-4}};
const winner:GameProfile={gameId:game.id,season:2099,team:'GB',opponent:'MIN',pointsFor:21,pointsAgainst:17,totalYards:350,opponentYards:300,penalties:4,penaltyYards:30,turnoverMargin:1,nonOffensiveTouchdowns:0};
const loser:GameProfile={...winner,team:'MIN',opponent:'GB',pointsFor:17,pointsAgainst:21,totalYards:300,opponentYards:350,turnoverMargin:-1};
const reference:GameProfileReference={schemaVersion:1,version:'synthetic-browser-fixture',startSeason:2025,endSeason:2025,sourceUrls:[],sourceChecksums:{},rows:Array.from({length:40},(_,i)=>({...winner,gameId:`synthetic-${i}`,season:2025})),notes:['Synthetic CI data, not historical evidence.']};
const snapshot:SourceSnapshot={id:'synthetic-browser-fixture',provider:'synthetic-ci',url:'https://example.invalid/ci-fixture',checksum:'a'.repeat(64),retrievedAt:'2099-09-01T21:00:00.000Z',path:'/synthetic/browser-fixture',license:'Synthetic test data',metadata:{synthetic:true}};
const analysis:AnalysisResult={schemaVersion:1,metrics:[],events:[],timeline:[],coverage:[],models:[],warnings:['Synthetic CI fixture. This is not an actual NFL result.'],gameAudit:buildGameAudit({game,profiles:[winner,loser],reference,referenceChecksum:'b'.repeat(64)})};
const scheduleSnapshot:SourceSnapshot={...snapshot,id:'synthetic-schedule-fixture',provider:'nflverse-schedules',url:sourceUrls.schedules,metadata:{synthetic:true,notes:'Synthetic target row for isolated UI testing; no schedule was fetched.'}};
analysis.gameAudit!.market=buildMarketAudit(game,scheduleSnapshot,await loadSpreadReference());
const {migrate,pool}=await import('../packages/core/src/db.js');
try{
 await migrate();
 const {saveAnalysis}=await import('../packages/core/src/repository.js');
 await saveAnalysis(game,[],[snapshot,scheduleSnapshot],analysis,'clean',{preventPublication:true});
 console.log('Seeded one synthetic, non-publishable browser report in the disposable CI database.');
}finally{await pool.end();}
