import path from 'node:path';
import { existsSync } from 'node:fs';

function findProjectRoot(){let current=process.cwd();for(let i=0;i<5;i++){if(existsSync(path.join(current,'packages/core/package.json')))return current;const parent=path.dirname(current);if(parent===current)break;current=parent;}return process.cwd();}
export const projectRoot=process.env.PROJECT_ROOT??findProjectRoot();
try { process.loadEnvFile(path.join(projectRoot,'.env')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
export const config={
  databaseUrl:process.env.DATABASE_URL??'postgresql://under_review:under_review_local@127.0.0.1:5439/under_review',
  dataDir:process.env.DATA_DIR??path.join(projectRoot,'data'),
  siteUrl:process.env.SITE_URL??'http://localhost:4380',
  brandName:process.env.BRAND_NAME??'Under Review',
  tagline:process.env.BRAND_TAGLINE??'What actually swung the game?',
  season:Number(process.env.TARGET_SEASON??2026),
  staging:process.env.PRIVATE_STAGING!=='false',
  livePostingAllowed:process.env.LIVE_POSTING_ALLOWED==='true',
  sessionSecret:process.env.SESSION_SECRET??'',
  tokenEncryptionKey:process.env.TOKEN_ENCRYPTION_KEY??'',
  analyticsTimeoutMs:Number(process.env.ANALYTICS_TIMEOUT_MS??900000),
  closeCallTolerance:Number(process.env.CLOSE_CALL_TOLERANCE??0.01),
  workerPollMs:Number(process.env.WORKER_POLL_MS??5000)
};

export function safeError(error:unknown):string {
  const text=error instanceof Error?error.message:String(error);
  return text.replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'postgresql://[redacted]').slice(0,1000);
}
export function log(event:string,details:Record<string,unknown>={}) {
  const safe=Object.fromEntries(Object.entries(details).filter(([k])=>!/secret|token|password|cookie|authorization/i.test(k)).map(([k,v])=>[k,v instanceof Error?safeError(v):v]));
  console.log(JSON.stringify({time:new Date().toISOString(),event,...safe}));
}
