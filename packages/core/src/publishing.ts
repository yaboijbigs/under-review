import { createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { query,transaction,audit } from './db.js';
import { config,safeError } from './config.js';
import { getReport } from './repository.js';
import { draftPost,validateDraft } from './summaries.js';
import { enqueue } from './jobs.js';

export interface PublishingSettings {mode:'off'|'draft-only'|'automatic';killSwitch:boolean;accountId:string|null;activatedAt:string|null}
export async function getPublishingSettings():Promise<PublishingSettings>{return (await query("SELECT value FROM settings WHERE key='publishing'")).rows[0]?.value??{mode:'draft-only',killSwitch:true,accountId:null,activatedAt:null};}
export async function createDraft(gameId:string,kind:'initial'|'correction'|'update'='initial'){
 const report=await getReport(gameId);if(!report)throw new Error('A validated report is required before drafting.');
 if(kind!=='initial'&&report.revision.number<2)throw new Error('An update or correction requires a later report revision.');
 const url=`${config.siteUrl}/games/${encodeURIComponent(gameId)}?revision=${report.revision.number}`;
 const draft=draftPost(report.game,report.revision.analysis,url,report.revision.statisticalStatus==='preliminary',report.revision.reviewStatus,kind);
 if(!validateDraft(draft.text,draft))throw new Error('Evidence or platform validation failed.');
 const id=randomUUID();const result=await query(`INSERT INTO publication_outbox(id,game_id,revision_id,kind,mode,status,text,evidence_ids,reason)
 VALUES($1,$2,$3,$4,'dry_run','draft',$5,$6,$7) ON CONFLICT(game_id,revision_id,account_id,kind,mode) DO UPDATE SET game_id=excluded.game_id RETURNING id`,[id,gameId,report.revision.id,kind,draft.text,JSON.stringify(draft.evidenceIds),config.staging?'Private staging URL: preview only, not publishable.':'Dry-run preview.']);return {id:result.rows[0].id,...draft};
}
export async function setPublishing(mode:PublishingSettings['mode'],accountId:string|null,userId:string){
 const current=await getPublishingSettings();
 if(mode==='automatic'){
  if(config.staging||!config.livePostingAllowed)throw new Error('Live publishing is disabled in this deployment.');
  if(!accountId||!(await query('SELECT id FROM oauth_accounts WHERE id=$1',[accountId])).rowCount)throw new Error('Connect and select the intended X account first.');
 }
 const settings={...current,mode,accountId,killSwitch:mode==='automatic'?current.killSwitch:true,activatedAt:mode==='automatic'&&current.mode!=='automatic'?new Date().toISOString():current.activatedAt};
 await query("UPDATE settings SET value=$1,updated_at=now() WHERE key='publishing'",[JSON.stringify(settings)]);await audit(userId,'publishing.settings',accountId,{mode});
}
export async function setKillSwitch(enabled:boolean,userId:string){
 const current=await getPublishingSettings();if(!enabled&&(config.staging||!config.livePostingAllowed))throw new Error('The publishing kill switch stays on in private staging.');
 await query("UPDATE settings SET value=$1,updated_at=now() WHERE key='publishing'",[JSON.stringify({...current,killSwitch:enabled})]);await audit(userId,'publishing.kill_switch',null,{enabled});
}
export async function approveDraft(id:string,userId:string){
 const row=(await query("SELECT * FROM publication_outbox WHERE id=$1 AND mode='dry_run'",[id])).rows[0];if(!row)throw new Error('Draft not found.');
 const settings=await getPublishingSettings();
 if(config.staging||!config.livePostingAllowed||settings.mode!=='automatic'||settings.killSwitch){
  await query("UPDATE publication_outbox SET status='approved',approved_by=$2,updated_at=now(),reason='Approved preview only; live publishing remains disabled.' WHERE id=$1",[id,userId]);await audit(userId,'draft.approved_preview',id);return id;
 }
 return queueLive(row,userId,settings);
}
async function queueLive(row:Record<string,any>,userId:string|null,settings:PublishingSettings){
 const game=(await query('SELECT publication_eligible,first_validated_at FROM games WHERE id=$1',[row.game_id])).rows[0];
 if(row.kind==='initial'&&(!game.publication_eligible||!settings.activatedAt||!game.first_validated_at||game.first_validated_at<new Date(settings.activatedAt)))throw new Error('Backfills and pre-activation games are ineligible for automatic initial publication.');
 const id=randomUUID();const result=await query(`INSERT INTO publication_outbox(id,game_id,revision_id,account_id,kind,mode,status,text,evidence_ids,approved_by)
 VALUES($1,$2,$3,$4,$5,'live','approved',$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[id,row.game_id,row.revision_id,settings.accountId,row.kind,row.text,JSON.stringify(row.evidence_ids),userId]);
 if(result.rowCount){await enqueue('publish',row.game_id,{outboxId:id},`publish:${id}`);await audit(userId,'publication.queued',id);}
 return result.rows[0]?.id??null;
}
export async function maybeAutomaticDraft(gameId:string){
 const settings=await getPublishingSettings();if(settings.mode==='off')return;
 const draft=await createDraft(gameId);
 if(settings.mode==='automatic'&&!settings.killSwitch&&!config.staging&&config.livePostingAllowed){const row=(await query('SELECT * FROM publication_outbox WHERE id=$1',[draft.id])).rows[0];await queueLive(row,null,settings);}
}
function encryptionKey(){if(!/^[a-f0-9]{64}$/i.test(config.tokenEncryptionKey))throw new Error('A 32-byte TOKEN_ENCRYPTION_KEY is required.');return Buffer.from(config.tokenEncryptionKey,'hex');}
export function encryptTokens(value:unknown){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
export function decryptTokens(value:string):{access_token:string;refresh_token?:string;expires_in:number}{const data=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString());}
export async function beginXConnection(userId:string):Promise<string>{
 const clientId=process.env.X_CLIENT_ID,redirect=process.env.X_REDIRECT_URI;if(!clientId||!redirect)throw new Error('X credentials are not configured. Drafts work without them.');
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
 const response=await fetch('https://api.x.com/2/users/me',{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('X account verification failed.');
 const {data}=await response.json() as {data:{id:string;username:string}};if(!/^\d+$/.test(data?.id))throw new Error('Invalid X account response.');
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
 await verifyPublicReport(`${config.siteUrl}/games/${encodeURIComponent(row.game_id)}?revision=${row.number}`);
 const token=await accountToken(row.account_id);const latest=await getPublishingSettings();if(latest.killSwitch||latest.mode!=='automatic'||latest.accountId!==row.account_id)throw new Error('Publishing settings changed.');
 const attemptId=randomUUID();const claimed=await transaction(async client=>{
  const claim=await client.query("UPDATE publication_outbox SET status='sending',updated_at=now() WHERE id=$1 AND status='approved' RETURNING id",[id]);if(!claim.rowCount)return false;
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
  if(!row.text.endsWith(reportUrl)||verifiedPostText(body.data)!==row.text.normalize('NFC'))throw new Error('The supplied post does not exactly match the intended full text and report URL.');
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
