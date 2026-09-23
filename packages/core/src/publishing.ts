import { createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { query,transaction,audit } from './db.js';
import { config,safeError } from './config.js';
import { getReport } from './repository.js';
import type { EvidenceDraft } from './summaries.js';
import { renderSocialPost,validateSocialPost,SOCIAL_TEMPLATE_VERSION,SOCIAL_API_TEMPLATE_VERSION } from './social-post.js';
import { getGameVerdict } from './consumer-summary.js';
import twitterText from 'twitter-text';

export interface PublishingSettings {mode:'off'|'draft-only'|'automatic';killSwitch:boolean;accountId:string|null;activatedAt:string|null}
export async function getPublishingSettings():Promise<PublishingSettings>{return (await query("SELECT value FROM settings WHERE key='publishing'")).rows[0]?.value??{mode:'draft-only',killSwitch:true,accountId:null,activatedAt:null};}
function expectedUsername():string|null{
 const value=process.env.X_EXPECTED_USERNAME?.trim().replace(/^@/,'');
 if(!value)return null;if(!/^[A-Za-z0-9_]{1,15}$/.test(value))throw new Error('X_EXPECTED_USERNAME must be a valid X handle.');return value;
}
function assertIntendedAccount(username:string){const expected=expectedUsername();if(expected&&username.toLowerCase()!==expected.toLowerCase())throw new Error(`Connect the intended X account @${expected}.`);}
function credentialReadiness(){
 const callbackUrl=`${config.siteUrl.replace(/\/$/,'')}/api/x/callback`;
 const credentials={clientId:!!process.env.X_CLIENT_ID?.trim(),clientSecret:!!process.env.X_CLIENT_SECRET?.trim(),redirectUri:!!process.env.X_REDIRECT_URI?.trim(),redirectMatches:process.env.X_REDIRECT_URI===callbackUrl,tokenEncryptionKey:/^[a-f0-9]{64}$/i.test(config.tokenEncryptionKey)};
 return {callbackUrl,credentials,connectionReady:Object.values(credentials).every(Boolean)};
}
export async function getPublishingReadiness(){
 const settings=await getPublishingSettings();const {callbackUrl,credentials,connectionReady}=credentialReadiness();
 const connectedAccounts=(await query<{id:string;username:string}>('SELECT id,username FROM oauth_accounts ORDER BY username')).rows;
 const selectedAccount=connectedAccounts.find(account=>account.id===settings.accountId)??null;
 const expectedAccount=expectedUsername();const accountMatches=!!selectedAccount&&(!expectedAccount||selectedAccount.username.toLowerCase()===expectedAccount.toLowerCase());
 const deploymentAllowsLive=!config.staging&&config.livePostingAllowed;
 const blockers:string[]=[];
 if(!credentials.clientId||!credentials.clientSecret)blockers.push('Configure the X OAuth 2.0 client ID and client secret.');
 if(!credentials.redirectMatches)blockers.push('Configure the exact callback URL in X and X_REDIRECT_URI.');
 if(!credentials.tokenEncryptionKey)blockers.push('Configure a persistent 32-byte hex token encryption key.');
 if(!selectedAccount)blockers.push('Connect and select the intended X account.');else if(!accountMatches)blockers.push(`Select the intended account @${expectedAccount}.`);
 if(!deploymentAllowsLive)blockers.push('Live publishing is disabled in this deployment.');
 if(settings.mode!=='automatic')blockers.push('Automatic publishing has not been activated.');
 if(settings.killSwitch)blockers.push('The publishing kill switch is on.');
 if(!settings.activatedAt||!Number.isFinite(Date.parse(settings.activatedAt)))blockers.push('An upcoming-game activation cutoff has not been recorded.');
 return {settings,callbackUrl,credentials,connectedAccounts,selectedAccount,expectedAccount,connectionReady,automaticReady:blockers.length===0,deploymentAllowsLive,blockers,cutoffPolicy:'kickoff_after_activation' as const,corrections:'manual_only' as const};
}
interface PublicationGame {publication_eligible:boolean;first_validated_at:Date|string|null;kickoff_at:Date|string|null}
export function initialPublicationIneligibility(game:PublicationGame|undefined,settings:PublishingSettings):string|null{
 if(!game?.publication_eligible)return 'Historical backfills are excluded from automatic initial posts.';
 const cutoff=settings.activatedAt?new Date(settings.activatedAt).getTime():NaN;
 if(!Number.isFinite(cutoff))return 'Activate automatic publishing to record its upcoming-game cutoff.';
 const kickoff=game.kickoff_at?new Date(game.kickoff_at).getTime():NaN;
 if(!Number.isFinite(kickoff)||kickoff<cutoff)return 'Only games kicking off after activation are eligible; earlier games stay preview-only.';
 const validated=game.first_validated_at?new Date(game.first_validated_at).getTime():NaN;
 if(!Number.isFinite(validated)||validated<cutoff)return 'A complete final report validated after activation is required.';
 return null;
}
export async function buildAutoPostPreview(gameId:string):Promise<EvidenceDraft&{gameId:string;revision:number;reportUrl:string;templateVersion:string;apiText:string;apiWeightedLength:number;apiTemplateVersion:string;eligibleForAutomation:boolean;ineligibilityReason:string|null}>{
 const report=await getReport(gameId);if(!report)throw new Error('A validated report is required before drafting.');
 const reportUrl=`${config.siteUrl}/games/${encodeURIComponent(gameId)}?revision=${report.revision.number}`;
 const draft=renderSocialPost(report.game,report.revision.analysis,reportUrl);
 const apiDraft=renderSocialPost(report.game,report.revision.analysis,reportUrl,'initial','names');
 const settings=await getPublishingSettings();const game=(await query<PublicationGame>('SELECT publication_eligible,first_validated_at,kickoff_at FROM games WHERE id=$1',[gameId])).rows[0];
 const duplicate=(await query("SELECT 1 FROM publication_outbox WHERE game_id=$1 AND account_id=$2 AND kind='initial' AND mode='live'",[gameId,settings.accountId])).rowCount;
 const ineligibilityReason=initialPublicationIneligibility(game,settings)??(getGameVerdict(report.revision.analysis.gameAudit).rating===null?'Automatic posting waits for a complete game rating.':null)??(duplicate?'This account already has an initial publication record for this game.':null);
 return {...draft,gameId,revision:report.revision.number,reportUrl,templateVersion:SOCIAL_TEMPLATE_VERSION,apiText:apiDraft.text,apiWeightedLength:apiDraft.weightedLength,apiTemplateVersion:SOCIAL_API_TEMPLATE_VERSION,eligibleForAutomation:!ineligibilityReason,ineligibilityReason};
}
export async function createDraft(gameId:string,kind:'initial'|'correction'|'update'='initial'){
 const report=await getReport(gameId);if(!report)throw new Error('A validated report is required before drafting.');
 if(kind!=='initial'&&report.revision.number<2)throw new Error('An update or correction requires a later report revision.');
 const url=`${config.siteUrl}/games/${encodeURIComponent(gameId)}?revision=${report.revision.number}`;
 const draft=renderSocialPost(report.game,report.revision.analysis,url,kind);
 if(!validateSocialPost(draft.text,draft))throw new Error('Evidence or platform validation failed.');
 const id=randomUUID();const result=await query(`INSERT INTO publication_outbox(id,game_id,revision_id,kind,mode,status,text,evidence_ids,reason,template_version)
 VALUES($1,$2,$3,$4,'dry_run','draft',$5,$6,$7,$8) ON CONFLICT(game_id,revision_id,account_id,kind,mode) DO UPDATE
 SET text=excluded.text,evidence_ids=excluded.evidence_ids,reason=excluded.reason,template_version=excluded.template_version,updated_at=now()
 WHERE publication_outbox.mode='dry_run' AND publication_outbox.status='draft' AND publication_outbox.approved_by IS NULL
 RETURNING id,text,evidence_ids,template_version`,[id,gameId,report.revision.id,kind,draft.text,JSON.stringify(draft.evidenceIds),config.staging?'Private staging URL: preview only, not publishable.':'Dry-run preview.',SOCIAL_TEMPLATE_VERSION]);
 // An already-approved preview is history. Return its own metadata rather than
 // attaching a new template's length or validation result to its preserved text.
 const stored=result.rows[0]??(await query("SELECT id,text,evidence_ids,template_version FROM publication_outbox WHERE game_id=$1 AND revision_id=$2 AND account_id='unconnected' AND kind=$3 AND mode='dry_run'",[gameId,report.revision.id,kind])).rows[0];
 if(!stored)throw new Error('The draft changed while it was being prepared; reload and try again.');
 return {id:stored.id,text:stored.text,evidenceIds:stored.evidence_ids,weightedLength:twitterText.parseTweet(stored.text).weightedLength,valid:stored.template_version===SOCIAL_TEMPLATE_VERSION&&validateSocialPost(stored.text,draft)};
}
export async function setPublishing(mode:PublishingSettings['mode'],accountId:string|null,userId:string){
 const current=await getPublishingSettings();
 if(mode==='automatic'){
  if(config.staging||!config.livePostingAllowed)throw new Error('Live publishing is disabled in this deployment.');
  if(!credentialReadiness().connectionReady)throw new Error('Complete the X application credentials and callback configuration first.');
  const account=accountId?(await query('SELECT username FROM oauth_accounts WHERE id=$1',[accountId])).rows[0]:null;
  if(!account)throw new Error('Connect and select the intended X account first.');assertIntendedAccount(account.username);
 }
 const activating=mode==='automatic'&&(current.mode!=='automatic'||current.accountId!==accountId);
 const settings={...current,mode,accountId,killSwitch:mode==='automatic'&&!activating?current.killSwitch:true,activatedAt:activating?new Date().toISOString():current.activatedAt};
 await query("UPDATE settings SET value=$1,updated_at=now() WHERE key='publishing'",[JSON.stringify(settings)]);await audit(userId,'publishing.settings',accountId,{mode});
}
export async function setKillSwitch(enabled:boolean,userId:string){
 const current=await getPublishingSettings();if(!enabled&&(config.staging||!config.livePostingAllowed))throw new Error('The publishing kill switch stays on while live publishing is disabled.');
 if(!enabled){const readiness=await getPublishingReadiness();if(!readiness.connectionReady||current.mode!=='automatic'||!readiness.selectedAccount)throw new Error('Configure and activate the intended X account before releasing the kill switch.');assertIntendedAccount(readiness.selectedAccount.username);}
 const activatedAt=!enabled&&current.killSwitch?new Date().toISOString():current.activatedAt;
 await query("UPDATE settings SET value=$1,updated_at=now() WHERE key='publishing'",[JSON.stringify({...current,killSwitch:enabled,activatedAt})]);await audit(userId,'publishing.kill_switch',null,{enabled,activatedAt});
}
export async function approveDraft(id:string,userId:string,{authorizeHistoricalInitial=false}:{authorizeHistoricalInitial?:boolean}={}){
 const row=(await query("SELECT o.*,r.number FROM publication_outbox o JOIN analysis_revisions r ON r.id=o.revision_id WHERE o.id=$1 AND o.mode='dry_run'",[id])).rows[0];if(!row)throw new Error('Draft not found.');
 const settings=await getPublishingSettings();
 if(authorizeHistoricalInitial){
  if(row.kind!=='initial')throw new Error('Historical authorization applies only to a game’s initial post.');
  if(!(await query("SELECT 1 FROM users WHERE id=$1 AND role='admin'",[userId])).rowCount)throw new Error('Administrator access is required for a historical initial post.');
  if(config.staging||!config.livePostingAllowed||settings.mode!=='automatic'||settings.killSwitch)throw new Error('Live publishing must be enabled before approving a historical initial post.');
  const report=await getReport(row.game_id);if(!report||getGameVerdict(report.revision.analysis.gameAudit).rating===null)throw new Error('A complete current game rating is required for historical publication.');
  const fresh=renderSocialPost(report.game,report.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${report.revision.number}`,'initial','names');
  if(!validateSocialPost(fresh.text,fresh))throw new Error('Current historical post failed validation.');
  return queueLive({...row,revision_id:report.revision.id,text:fresh.text,evidence_ids:fresh.evidenceIds,template_version:SOCIAL_API_TEMPLATE_VERSION},userId,settings,true);
 }
 if(config.staging||!config.livePostingAllowed||settings.mode!=='automatic'||settings.killSwitch){
  await query("UPDATE publication_outbox SET status='approved',approved_by=$2,updated_at=now(),reason='Approved preview only; live publishing remains disabled.' WHERE id=$1",[id,userId]);await audit(userId,'draft.approved_preview',id);return id;
 }
 const report=await getReport(row.game_id,row.number);if(!report)throw new Error('The approved report revision is unavailable.');
 const liveDraft=renderSocialPost(report.game,report.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${row.number}`,row.kind,'names');
 if(!validateSocialPost(liveDraft.text,liveDraft))throw new Error('API post failed canonical validation.');
 return queueLive({...row,text:liveDraft.text,evidence_ids:liveDraft.evidenceIds,template_version:SOCIAL_API_TEMPLATE_VERSION},userId,settings);
}
async function queueLive(row:Record<string,any>,userId:string|null,settings:PublishingSettings,manualHistoricalInitial=false){
 return transaction(async client=>{
  const latest=(await client.query("SELECT value FROM settings WHERE key='publishing' FOR UPDATE")).rows[0].value as PublishingSettings;
  if(config.staging||!config.livePostingAllowed||latest.mode!=='automatic'||latest.killSwitch||latest.accountId!==settings.accountId||latest.activatedAt!==settings.activatedAt)throw new Error('Publishing settings changed; no post queued.');
  const account=(await client.query('SELECT username FROM oauth_accounts WHERE id=$1',[latest.accountId])).rows[0];if(!account)throw new Error('Connected X account missing.');assertIntendedAccount(account.username);
  const game=(await client.query('SELECT publication_eligible,first_validated_at,kickoff_at FROM games WHERE id=$1',[row.game_id])).rows[0];
  if(manualHistoricalInitial&&(!userId||row.kind!=='initial'||!game?.first_validated_at||!(await client.query("SELECT 1 FROM users WHERE id=$1 AND role='admin'",[userId])).rowCount))throw new Error('A validated final report and explicit administrator authorization are required.');
  const reason=row.kind==='initial'?initialPublicationIneligibility(game,latest):null;if(reason&&!manualHistoricalInitial){if(userId)throw new Error(reason);return null;}
  if((userId===null||manualHistoricalInitial)&&(await client.query('SELECT id FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC LIMIT 1',[row.game_id])).rows[0]?.id!==row.revision_id)throw new Error('A newer report is ready; retry with the current preview.');
  const id=randomUUID();const result=await client.query(`INSERT INTO publication_outbox(id,game_id,revision_id,account_id,kind,mode,status,text,evidence_ids,approved_by,template_version,queued_automatically,manual_historical_initial)
   VALUES($1,$2,$3,$4,$5,'live','approved',$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,[id,row.game_id,row.revision_id,latest.accountId,row.kind,row.text,JSON.stringify(row.evidence_ids),userId,row.template_version??null,userId===null,manualHistoricalInitial]);
  if(!result.rowCount&&userId===null){
   const pending=(await client.query("SELECT id,revision_id FROM publication_outbox WHERE game_id=$1 AND account_id=$2 AND kind='initial' AND mode='live' AND status='approved' AND queued_automatically=true AND template_version=$3 FOR UPDATE",[row.game_id,latest.accountId,SOCIAL_API_TEMPLATE_VERSION])).rows[0];
   // A previously queued rating may have been withdrawn before delivery. Resume only
   // that unsent, unambiguous record when a later complete rating becomes available.
   if(pending&&pending.revision_id!==row.revision_id){
    await client.query('UPDATE publication_outbox SET revision_id=$2,text=$3,evidence_ids=$4,template_version=$5,reason=null,updated_at=now() WHERE id=$1',[pending.id,row.revision_id,row.text,JSON.stringify(row.evidence_ids),row.template_version]);
    await client.query("INSERT INTO jobs(id,kind,game_id,job_key,payload) VALUES($1,'publish',$2,$3,$4) ON CONFLICT(job_key) DO NOTHING",[randomUUID(),row.game_id,`publish:${pending.id}:revision:${row.revision_id}`,JSON.stringify({outboxId:pending.id})]);return pending.id;
   }
  }
  if(result.rowCount){
   await client.query("INSERT INTO jobs(id,kind,game_id,job_key,payload) VALUES($1,'publish',$2,$3,$4) ON CONFLICT(job_key) DO NOTHING",[randomUUID(),row.game_id,`publish:${id}`,JSON.stringify({outboxId:id})]);
   await client.query('INSERT INTO audit_log(user_id,action,target,details) VALUES($1,$2,$3,$4)',[userId,'publication.queued',id,JSON.stringify({automatic:userId===null,manualHistoricalInitial,accountId:latest.accountId,activatedAt:latest.activatedAt,revisionId:row.revision_id,templateVersion:row.template_version??null})]);
  }
  return result.rows[0]?.id??null;
 });
}
export async function maybeAutomaticDraft(gameId:string){
 const settings=await getPublishingSettings();if(settings.mode==='off')return;
 const live=settings.mode==='automatic'&&!settings.killSwitch&&!config.staging&&config.livePostingAllowed;
 if(live){const game=(await query<PublicationGame>('SELECT publication_eligible,first_validated_at,kickoff_at FROM games WHERE id=$1',[gameId])).rows[0];if(initialPublicationIneligibility(game,settings))return;}
 const report=await getReport(gameId);if(!report)throw new Error('A validated report is required before drafting.');
 if(live&&getGameVerdict(report.revision.analysis.gameAudit).rating===null)return;
 const draft=renderSocialPost(report.game,report.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(gameId)}?revision=${report.revision.number}`);
 if(!validateSocialPost(draft.text,draft))throw new Error('Evidence or platform validation failed.');
 // Retain earlier previews, but always queue freshly rendered text from the latest report.
 // The live row and delivery job are inserted together; retrying analysis can safely resume here.
 const row=await transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automatic-draft:${gameId}`]);
  const existing=(await client.query("SELECT * FROM publication_outbox WHERE game_id=$1 AND kind='initial' AND mode='dry_run' ORDER BY created_at,id LIMIT 1",[gameId])).rows[0];
  if(existing)return {...existing,revision_id:report.revision.id,text:draft.text,evidence_ids:draft.evidenceIds,template_version:SOCIAL_TEMPLATE_VERSION};
  return (await client.query(`INSERT INTO publication_outbox(id,game_id,revision_id,kind,mode,status,text,evidence_ids,reason,template_version,queued_automatically)
   VALUES($1,$2,$3,'initial','dry_run','draft',$4,$5,$6,$7,true) ON CONFLICT(game_id,revision_id,account_id,kind,mode) DO UPDATE SET game_id=excluded.game_id RETURNING *`,[randomUUID(),gameId,report.revision.id,draft.text,JSON.stringify(draft.evidenceIds),config.staging?'Private staging URL: preview only, not publishable.':'Automatic initial preview; later revisions require explicit correction/update approval.',SOCIAL_TEMPLATE_VERSION])).rows[0];
 });
 if(live){
  const apiDraft=renderSocialPost(report.game,report.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(gameId)}?revision=${report.revision.number}`,'initial','names');
  if(!validateSocialPost(apiDraft.text,apiDraft))throw new Error('Automatic API post failed canonical validation.');
  await queueLive({...row,text:apiDraft.text,evidence_ids:apiDraft.evidenceIds,template_version:SOCIAL_API_TEMPLATE_VERSION},null,settings);
 }
}
function encryptionKey(){if(!/^[a-f0-9]{64}$/i.test(config.tokenEncryptionKey))throw new Error('A 32-byte TOKEN_ENCRYPTION_KEY is required.');return Buffer.from(config.tokenEncryptionKey,'hex');}
export function encryptTokens(value:unknown){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
export function decryptTokens(value:string):{access_token:string;refresh_token?:string;expires_in:number}{const data=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString());}
export async function beginXConnection(userId:string):Promise<string>{
 const clientId=process.env.X_CLIENT_ID,redirect=process.env.X_REDIRECT_URI;if(!clientId||!redirect||!credentialReadiness().connectionReady)throw new Error('Configure X client credentials, the exact callback URL, and token encryption before connecting. Drafts work without them.');
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
 await query("INSERT INTO oauth_states(state_hash,user_id,verifier,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[createHash('sha256').update(state).digest('hex'),userId,verifier]);
 const url=new URL('https://x.com/i/oauth2/authorize');url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirect,scope:'tweet.read tweet.write users.read offline.access',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();return url.toString();
}
async function tokenRequest(params:Record<string,string>){
 const clientId=process.env.X_CLIENT_ID,secret=process.env.X_CLIENT_SECRET;if(!clientId||!secret)throw new Error('X client credentials missing.');
 const response=await fetch('https://api.x.com/2/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${clientId}:${secret}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`X token endpoint rejected authorization (${response.status}).`);
 const data=await response.json() as {access_token:string;refresh_token?:string;expires_in:number};if(!data.access_token||!Number.isFinite(data.expires_in))throw new Error('Invalid X token response.');return data;
}
export async function finishXConnection(userId:string,state:string,code:string){
 const row=(await query('DELETE FROM oauth_states WHERE state_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING verifier',[createHash('sha256').update(state).digest('hex'),userId])).rows[0];if(!row)throw new Error('Expired or invalid OAuth state.');
 const tokens=await tokenRequest({grant_type:'authorization_code',code,code_verifier:row.verifier,redirect_uri:process.env.X_REDIRECT_URI!});
 if(!tokens.refresh_token)throw new Error('Reconnect X with offline.access permission to allow scheduled publishing.');
 const response=await fetch('https://api.x.com/2/users/me',{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('X account verification failed.');
 const {data}=await response.json() as {data:{id:string;username:string}};if(!/^\d+$/.test(data?.id)||!/^[A-Za-z0-9_]{1,15}$/.test(data?.username))throw new Error('Invalid X account response.');assertIntendedAccount(data.username);
 await query('INSERT INTO oauth_accounts(id,username,encrypted_tokens,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET username=excluded.username,encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,updated_at=now()',[data.id,data.username,encryptTokens(tokens),new Date(Date.now()+tokens.expires_in*1000)]);await audit(userId,'x.connected',data.id);return data;
}
async function accountToken(accountId:string,rejectedToken?:string){return transaction(async client=>{
 const account=(await client.query('SELECT * FROM oauth_accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];if(!account)throw new Error('Connected X account missing.');
 let tokens=decryptTokens(account.encrypted_tokens);
 // Another worker may already have rotated the rejected token while this one waited.
 if(new Date(account.expires_at).getTime()<Date.now()+60000||(rejectedToken!==undefined&&tokens.access_token===rejectedToken)){if(!tokens.refresh_token)throw new Error('Reconnect X: refresh permission unavailable.');const fresh=await tokenRequest({grant_type:'refresh_token',refresh_token:tokens.refresh_token});tokens={...tokens,...fresh};await client.query('UPDATE oauth_accounts SET encrypted_tokens=$2,expires_at=$3,updated_at=now() WHERE id=$1',[accountId,encryptTokens(tokens),new Date(Date.now()+fresh.expires_in*1000)]);}
 return tokens.access_token;
});}
export function classifyPostResponse(status:number,hasId:boolean):'published'|'retry'|'failed'|'unknown_outcome'{if(status>=200&&status<300)return hasId?'published':'unknown_outcome';if(status===429)return 'retry';if(status>=500||status===408)return 'unknown_outcome';return 'failed';}
export async function verifyPublicReport(url:string){
 const target=new URL(url);if(target.protocol!=='https:'||target.origin!==new URL(config.siteUrl).origin)throw new Error('A public HTTPS report URL is required.');
 const addresses=await lookup(target.hostname,{all:true});
 if(!addresses.length||addresses.some(a=>/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80)/i.test(a.address)))throw new Error('Report URL resolves to a private address.');
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});if(response.status!==200)throw new Error(`Public report unavailable (${response.status}).`);
}
export async function publishOutbox(id:string){
 const settings=await getPublishingSettings();if(config.staging||!config.livePostingAllowed||settings.mode!=='automatic'||settings.killSwitch)throw new Error('Live publishing blocked by deployment or operator settings.');
 const row=(await query("SELECT o.*,r.number FROM publication_outbox o JOIN analysis_revisions r ON r.id=o.revision_id WHERE o.id=$1 AND o.mode='live' AND o.status='approved'",[id])).rows[0];if(!row)return;
 if(row.account_id!==settings.accountId)throw new Error('Publishing account mismatch.');
 const account=(await query('SELECT username FROM oauth_accounts WHERE id=$1',[row.account_id])).rows[0];if(!account)throw new Error('Connected X account missing.');assertIntendedAccount(account.username);
 if(row.template_version!==SOCIAL_API_TEMPLATE_VERSION){
  await query("UPDATE publication_outbox SET status='failed',reason='Stored API template is stale; delivery stopped for operator review.',updated_at=now() WHERE id=$1 AND status='approved'",[id]);return;
 }
 if(row.queued_automatically){
  const current=await getReport(row.game_id);
  if(!current||getGameVerdict(current.revision.analysis.gameAudit).rating===null){await query("UPDATE publication_outbox SET reason='Awaiting a complete current game rating.',updated_at=now() WHERE id=$1 AND status='approved'",[id]);return;}
  if(current.revision.id!==row.revision_id){
   const fresh=renderSocialPost(current.game,current.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${current.revision.number}`,'initial','names');
   if(!validateSocialPost(fresh.text,fresh))throw new Error('Current automatic post failed validation.');
   await query("UPDATE publication_outbox SET revision_id=$2,text=$3,evidence_ids=$4,template_version=$5,reason=null,updated_at=now() WHERE id=$1 AND status='approved'",[id,current.revision.id,fresh.text,JSON.stringify(fresh.evidenceIds),SOCIAL_API_TEMPLATE_VERSION]);
   Object.assign(row,{revision_id:current.revision.id,number:current.revision.number,text:fresh.text});
  }
 }
 if(row.manual_historical_initial&&(!row.approved_by||row.queued_automatically||row.kind!=='initial'||!(await query("SELECT 1 FROM users WHERE id=$1 AND role='admin'",[row.approved_by])).rowCount))throw new Error('Historical publication is missing its explicit administrator authorization.');
 if(row.kind==='initial'&&!row.manual_historical_initial){
  const game=(await query<PublicationGame>('SELECT publication_eligible,first_validated_at,kickoff_at FROM games WHERE id=$1',[row.game_id])).rows[0];const reason=initialPublicationIneligibility(game,settings);
  if(reason){await query("UPDATE publication_outbox SET status='cancelled',reason=$2,updated_at=now() WHERE id=$1 AND status='approved'",[id,reason]);return;}
 }
 const pinned=await getReport(row.game_id,row.number);
 const canonical=pinned?renderSocialPost(pinned.game,pinned.revision.analysis,`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${row.number}`,row.kind,'names'):null;
 if(!canonical||!validateSocialPost(row.text,canonical)){
  await query("UPDATE publication_outbox SET status='failed',reason='Stored API text differs from the canonical team-name template; delivery stopped for operator review.',updated_at=now() WHERE id=$1 AND status='approved'",[id]);return;
 }
 await verifyPublicReport(`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${row.number}`);
 const token=await accountToken(row.account_id);const latest=await getPublishingSettings();if(latest.killSwitch||latest.mode!=='automatic'||latest.accountId!==row.account_id||latest.activatedAt!==settings.activatedAt)throw new Error('Publishing settings changed.');
 const attemptId=randomUUID();const claimed=await transaction(async client=>{
  const claim=await client.query("UPDATE publication_outbox SET status='sending',updated_at=now() WHERE id=$1 AND status='approved' AND text=$2 AND template_version=$3 AND revision_id=$4 RETURNING id",[id,row.text,SOCIAL_API_TEMPLATE_VERSION,row.revision_id]);if(!claim.rowCount)return false;
  await client.query("INSERT INTO publication_attempts(id,outbox_id,state) VALUES($1,$2,'sending')",[attemptId,id]);return true;
 });if(!claimed)return;
 let outcome:'published'|'retry'|'failed'|'unknown_outcome'='unknown_outcome',httpStatus:number|null=null,externalId:string|null=null,reason:string|null=null,retryAfter=60;
 try{
  const response=await fetch('https://api.x.com/2/tweets',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({text:row.text}),signal:AbortSignal.timeout(15000)});
  httpStatus=response.status;const data=await response.json().catch(()=>null) as {data?:{id?:string}}|null;externalId=data?.data?.id&&/^\d+$/.test(data.data.id)?data.data.id:null;outcome=classifyPostResponse(response.status,!!externalId);
  reason=outcome==='published'?null:`X returned HTTP ${response.status}; ${outcome}.`;
  const reset=Number(response.headers.get('x-rate-limit-reset')??0);retryAfter=Number.isFinite(reset)?Math.min(86400,Math.max(60,reset-Math.floor(Date.now()/1000))):60;
 }catch(error){reason='Submission outcome unknown; reconcile before any new attempt. '+safeError(error);}
 // An explicit 401 rejects the submission. Refresh once, then schedule a separate attempt.
 // Timeouts, disconnects, 408, 5xx and malformed success responses never enter this path.
 if(httpStatus===401&&outcome==='failed'){
  const previous=(await query('SELECT count(*)::integer AS n FROM publication_attempts WHERE outbox_id=$1 AND http_status=401',[id])).rows[0].n;
  if(previous===0){try{await accountToken(row.account_id,token);outcome='retry';reason='X rejected submission with HTTP 401; token refreshed, explicit retry queued.';}catch{reason='X rejected submission with HTTP 401; token refresh failed. Reconnect the intended account before operator review.';}}
  else reason='X rejected submission with HTTP 401 after one refresh; automatic retry stopped. Reconnect the intended account.';
 }
 await transaction(async client=>{
  await client.query('UPDATE publication_attempts SET state=$2,http_status=$3,error=$4,external_id=$5,finished_at=now() WHERE id=$1',[attemptId,outcome,httpStatus,reason,externalId]);
  await client.query('UPDATE publication_outbox SET status=$2,reason=$3,external_id=$4,updated_at=now() WHERE id=$1',[id,outcome==='retry'?'approved':outcome,reason,externalId]);
  if(outcome==='retry')await client.query("INSERT INTO jobs(id,kind,game_id,job_key,payload,run_after) VALUES($1,'publish',$2,$3,$4,$5) ON CONFLICT(job_key) DO NOTHING",[randomUUID(),row.game_id,`publish:${id}:retry:${attemptId}`,JSON.stringify({outboxId:id}),new Date(Date.now()+retryAfter*1000)]);
 });
}
export async function recoverUnknownPublications(){await query("UPDATE publication_outbox SET status='unknown_outcome',reason='Publisher interrupted after submission may have started; reconciliation required.',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '5 minutes'");}

/** Compare the original full text using X's URL entities, never by following a supplied URL. */
export function verifiedPostText(post:unknown):string{
 if(!post||typeof post!=='object'||typeof (post as any).text!=='string')throw new Error('X did not return the complete post text.');
 const data=post as {text:string;entities?:{urls?:{url?:unknown;expanded_url?:unknown}[]}};
 const entities=data.entities?.urls??[];if(!Array.isArray(entities))throw new Error('Invalid X URL entities.');
 const urls=new Map<string,string>();
 for(const entity of entities){
  if(typeof entity.url!=='string'||typeof entity.expanded_url!=='string'||!/^https:\/\/t\.co\/[A-Za-z0-9]+$/.test(entity.url))throw new Error('Incomplete X URL entity.');
  if(urls.has(entity.url)&&urls.get(entity.url)!==entity.expanded_url)throw new Error('Conflicting X URL entities.');
  urls.set(entity.url,entity.expanded_url);
 }
 // Replace complete URL tokens in one pass so an expanded URL cannot trigger another replacement.
 return data.text.replace(/https:\/\/t\.co\/[A-Za-z0-9]+/g,url=>urls.get(url)??url).normalize('NFC');
}

/** Resolve uncertainty without ever issuing a second POST. Missing/deleted posts stay uncertain. */
export async function reconcilePublication(outboxId:string,resolution:'posted'|'cancel',externalId:string|null,userId:string):Promise<void>{
 if(!(await query("SELECT 1 FROM users WHERE id=$1 AND role='admin'",[userId])).rowCount)throw new Error('Administrator access is required to reconcile a publication.');
 if(resolution!=='posted'&&resolution!=='cancel')throw new Error('Choose a verified existing post or permanent cancellation.');
 const row=(await query("SELECT o.*,r.number FROM publication_outbox o JOIN analysis_revisions r ON r.id=o.revision_id WHERE o.id=$1 AND o.mode='live' AND o.status='unknown_outcome'",[outboxId])).rows[0];
 if(!row)throw new Error('Only an unknown publication outcome can be reconciled.');
 if(resolution==='posted'){
  if(!externalId||!/^\d{1,30}$/.test(externalId))throw new Error('A numeric X post ID is required.');
  const token=await accountToken(row.account_id);
  const url=new URL(`https://api.x.com/2/tweets/${externalId}`);url.searchParams.set('tweet.fields','author_id,entities');
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new Error(`X could not verify the supplied post (HTTP ${response.status}). The outcome remains unknown; absence is not permission to resend.`);
  const body=await response.json() as {data?:{id?:string;author_id?:string;text?:string;entities?:unknown}};
  if(body.data?.id!==externalId||body.data.author_id!==row.account_id)throw new Error('The supplied post does not belong to the intended X account.');
  const reportUrl=`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${row.number}`;
  const recognizedFooter=row.text.endsWith(reportUrl)||row.text.endsWith(`\n\nSee the Review: ${reportUrl}\n\n#NFL #UnderReview`);
  if(!recognizedFooter||verifiedPostText(body.data)!==row.text.normalize('NFC'))throw new Error('The supplied post does not exactly match the intended full text and report URL.');
 }
 await transaction(async client=>{
  const current=(await client.query('SELECT * FROM publication_outbox WHERE id=$1 FOR UPDATE',[outboxId])).rows[0];
  if(!current||current.status!=='unknown_outcome'||current.mode!=='live'||current.text!==row.text||current.account_id!==row.account_id)throw new Error('The publication changed during reconciliation; reload and review it again.');
  if(resolution==='posted'){
   // Account advisory lock makes the external-ID check atomic without a broad schema change.
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`publication-reconcile:${row.account_id}`]);
   if((await client.query("SELECT 1 FROM publication_outbox WHERE mode='live' AND account_id=$1 AND external_id=$2 AND id<>$3",[row.account_id,externalId,outboxId])).rowCount)throw new Error('This X post is already linked to another publication.');
  }
  const status=resolution==='posted'?'published':'cancelled';
  const reason=resolution==='posted'?'Administrator reconciled the existing X post after verifying author, full text and report URL.':'Administrator permanently cancelled further submission; the original outcome may remain unknown.';
  await client.query('UPDATE publication_outbox SET status=$2,external_id=$3,reason=$4,updated_at=now() WHERE id=$1',[outboxId,status,resolution==='posted'?externalId:null,reason]);
  await client.query('INSERT INTO publication_attempts(id,outbox_id,state,http_status,external_id,error,finished_at) VALUES($1,$2,$3,$4,$5,$6,now())',[randomUUID(),outboxId,`reconciled_${status}`,resolution==='posted'?200:null,resolution==='posted'?externalId:null,reason]);
  await client.query('INSERT INTO audit_log(user_id,action,target,details) VALUES($1,$2,$3,$4)',[userId,'publication.reconciled',outboxId,JSON.stringify({resolution,accountId:row.account_id,externalId:resolution==='posted'?externalId:null,verified:resolution==='posted'})]);
 });
}
