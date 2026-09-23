import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { query,transaction } from './db.js';
import { config } from './config.js';
import { getGameVerdict,SUSPICION_RULES_VERSION } from './consumer-summary.js';
import type { GameAudit } from './contracts.js';

export const FEEDBACK_COOKIE='ur_feedback';
export const FEEDBACK_COMMENT_LIMIT=1000;
export type FeedbackRating=1|2|3|4|5;
export interface VisitorFeedback {agreement:'agree'|'disagree';rating:FeedbackRating|null;comment:string;updatedAt:string;public:boolean}
export interface VisitorFeedbackRecord extends VisitorFeedback {id:string;gameId:string;revisionId:string;revisionNumber:number;modelRating:FeedbackRating;rulesVersion:string}
export interface PublicVisitorFeedback extends VisitorFeedback {id:string;revisionId:string;revisionNumber:number;modelRating:FeedbackRating;rulesVersion:string}
export interface PublicFeedbackPage {entries:PublicVisitorFeedback[];nextCursor:string|null;summary:FeedbackSummary}
export interface FeedbackSummary {total:number;agree:number;disagree:number;ratingCount:number;averageRating:number|null;ratings:{rating:FeedbackRating;count:number}[]}
export class FeedbackError extends Error {constructor(public status:number,message:string){super(message);}}
const supportedRules=(value:string)=>value===SUSPICION_RULES_VERSION||value==='game-suspicion-v2'||value==='game-suspicion-v3';
const revisionSchema=z.object({revisionId:z.uuid(),rulesVersion:z.string().refine(supportedRules)});
const submissionSchema=revisionSchema.extend({action:z.enum(['thumb','details']).default('details'),agreement:z.enum(['agree','disagree']),rating:z.number().int().min(1).max(5).nullable().default(null),modelRating:z.number().int().min(1).max(5),comment:z.string().max(FEEDBACK_COMMENT_LIMIT).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)).transform(value=>value.replaceAll('\r\n','\n').trim()).default(''),public:z.boolean().default(false)}).strict();
export type FeedbackSubmission=z.infer<typeof submissionSchema>;
function currentRules(input:unknown){if(input&&typeof input==='object'&&'rulesVersion' in input&&typeof input.rulesVersion==='string'&&!supportedRules(input.rulesVersion))throw new FeedbackError(409,'The rating rules have changed. Reload the report before sending feedback.');}
export function parseFeedbackRevision(input:unknown){currentRules(input);const result=revisionSchema.safeParse(input);if(!result.success)throw new FeedbackError(400,'This report reference is invalid. Reload the report and try again.');return result.data;}
export function parseFeedbackSubmission(input:unknown):FeedbackSubmission {currentRules(input);const result=submissionSchema.safeParse(input);if(!result.success)throw new FeedbackError(400,`Choose a rating from 1 to 5 and keep your explanation under ${FEEDBACK_COMMENT_LIMIT+1} characters.`);return result.data;}
function secret(){if(config.sessionSecret.length<32)throw new Error('Visitor feedback signing is unavailable.');return config.sessionSecret;}
function signature(value:string){return createHmac('sha256',secret()).update('visitor-feedback:'+value).digest('base64url');}
export function createFeedbackToken(){const nonce=randomBytes(32).toString('base64url');return `${nonce}.${signature(nonce)}`;}
export function feedbackVisitorId(token:string|undefined):string|null {
 if(!token||!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token))return null;
 const [nonce,signed]=token.split('.'),expected=signature(nonce);
 if(!timingSafeEqual(Buffer.from(signed),Buffer.from(expected)))return null;
 return createHash('sha256').update('visitor-feedback:'+nonce).digest('hex');
}
const cookieName=()=>config.siteUrl.startsWith('https:')?`__Host-${FEEDBACK_COOKIE}`:FEEDBACK_COOKIE;
export function feedbackCookie(token:string){return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${config.siteUrl.startsWith('https:')?'; Secure':''}`;}
export function feedbackTokenFromRequest(request:Request):string|undefined {const name=cookieName();return request.headers.get('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith(name+'='))?.slice(name.length+1);}
export function feedbackClientKey(request:Request):string {
 const ip=request.headers.get('cf-connecting-ip');
 if(process.env.TRUST_CLOUDFLARE_CLIENT_IP!=='true'||!ip||!isIP(ip)||ip.includes('%'))return 'feedback:network:untrusted';
 const canonical=isIP(ip)===6?new URL(`http://[${ip}]/`).hostname:ip;
 // Keep client addresses out of stored limiter keys and application logs.
 return 'feedback:network:'+createHmac('sha256',secret()).update(canonical).digest('hex');
}
function validGameId(gameId:string){if(!/^[A-Za-z0-9_-]{1,100}$/.test(gameId))throw new FeedbackError(400,'Invalid game.');}
function feedbackFields(row:Record<string,any>):VisitorFeedback {return {agreement:row.agreement,rating:row.rating,comment:row.comment,updatedAt:new Date(row.updated_at).toISOString(),public:row.is_public===true};}
export async function getVisitorFeedback(gameId:string,revisionId:string,rulesVersion:string,visitorId:string):Promise<VisitorFeedback|null> {
 validGameId(gameId);parseFeedbackRevision({revisionId,rulesVersion});
 const row=(await query('SELECT agreement,rating,comment,updated_at,is_public FROM visitor_feedback WHERE game_id=$1 AND visitor_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1',[gameId,visitorId])).rows[0];
 return row?feedbackFields(row):null;
}
export async function saveVisitorFeedback(gameId:string,visitorId:string,input:unknown):Promise<VisitorFeedback> {
 validGameId(gameId);if(!/^[a-f0-9]{64}$/.test(visitorId))throw new FeedbackError(401,'Please reload the report before sending feedback.');
 const submission=parseFeedbackSubmission(input);
 const revision=(await query('SELECT analysis->\'gameAudit\' AS audit FROM analysis_revisions WHERE id=$1 AND game_id=$2',[submission.revisionId,gameId])).rows[0];
 if(!revision)throw new FeedbackError(404,'This report version is unavailable. Reload the report and try again.');
 const verdict=getGameVerdict(revision.audit as GameAudit|undefined);
 if(verdict.rating===null||verdict.rulesVersion!==submission.rulesVersion||verdict.rating!==submission.modelRating)throw new FeedbackError(409,'The rating has changed or is unavailable. Reload the report before sending feedback.');
 return transaction(async client=>{
  // Serialize one browser's responses across report versions. A thumb must not
  // erase details written by a concurrent request on another report version.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`feedback:${gameId}:${visitorId}`]);
  let rating=submission.rating,comment=submission.comment;
  if(submission.action==='thumb'){
   const previous=(await client.query('SELECT rating,comment,is_public FROM visitor_feedback WHERE game_id=$1 AND visitor_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1',[gameId,visitorId])).rows[0];
   rating=previous?.is_public===true?previous.rating:null;
   comment=previous?.is_public===true?previous.comment:'';
  }
  const row=(await client.query(`INSERT INTO visitor_feedback(id,game_id,revision_id,rules_version,visitor_id,agreement,rating,model_rating,comment,is_public,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
 ON CONFLICT(game_id,revision_id,rules_version,visitor_id) DO UPDATE SET agreement=EXCLUDED.agreement,rating=EXCLUDED.rating,comment=EXCLUDED.comment,is_public=EXCLUDED.is_public,updated_at=clock_timestamp()
 RETURNING agreement,rating,comment,updated_at,is_public`,[randomUUID(),gameId,submission.revisionId,submission.rulesVersion,visitorId,submission.agreement,rating,verdict.rating,comment,submission.public])).rows[0];
  return feedbackFields(row);
 });
}
const latestForGame='SELECT DISTINCT ON(visitor_id) * FROM visitor_feedback WHERE game_id=$1 ORDER BY visitor_id,updated_at DESC,id DESC';
export async function getFeedbackSummary(gameId:string,revisionId?:string,rulesVersion?:string):Promise<FeedbackSummary> {
 validGameId(gameId);if(revisionId!==undefined||rulesVersion!==undefined)parseFeedbackRevision({revisionId,rulesVersion});
 const rows=(await query(`WITH latest AS (${latestForGame}) SELECT agreement,rating,count(*)::integer AS count FROM latest WHERE is_public=true GROUP BY agreement,rating`,[gameId])).rows;
 const summary:FeedbackSummary={total:0,agree:0,disagree:0,ratingCount:0,averageRating:null,ratings:([1,2,3,4,5] as const).map(rating=>({rating,count:0}))};
 let sum=0;for(const row of rows){summary.total+=row.count;summary[row.agreement as 'agree'|'disagree']+=row.count;if(row.rating!==null){summary.ratings[row.rating-1].count+=row.count;summary.ratingCount+=row.count;sum+=row.rating*row.count;}}
 summary.averageRating=summary.ratingCount?sum/summary.ratingCount:null;
 return summary;
}
/** One archive query for all visible cards; never one request per card. */
export async function getPublicFeedbackCounts(gameIds:string[]):Promise<Record<string,number>> {
 const ids=[...new Set(gameIds)];if(!ids.length)return {};ids.forEach(validGameId);
 const rows=(await query(`WITH latest AS (SELECT DISTINCT ON(game_id,visitor_id) game_id,is_public FROM visitor_feedback WHERE game_id=ANY($1::text[]) ORDER BY game_id,visitor_id,updated_at DESC,id DESC) SELECT game_id,count(*)::integer AS count FROM latest WHERE is_public=true GROUP BY game_id`,[ids])).rows;
 return Object.fromEntries(rows.map(row=>[row.game_id,row.count]));
}
/** Only written comments appear in the discussion; its summary includes every public response.
 * Public comments require explicit per-submission consent. Legacy rows remain private;
 * resubmitting with public:false also removes a previously public entry from this list.
 * Text is untrusted plaintext. The cursor contains only its public timestamp/record ID. */
export async function listPublicVisitorFeedback(gameId:string,options:{limit?:number;cursor?:string|null}={}):Promise<PublicFeedbackPage> {
 validGameId(gameId);
 const limit=options.limit??20;
 if(!Number.isInteger(limit)||limit<1||limit>50)throw new FeedbackError(400,'Choose a feedback page size from 1 to 50.');
 let after:[string,string]|null=null;
 if(options.cursor!==undefined&&options.cursor!==null){
  try{
   if(options.cursor.length>256||!/^[A-Za-z0-9_-]+$/.test(options.cursor))throw new Error();
   const decoded=Buffer.from(options.cursor,'base64url');if(decoded.toString('base64url')!==options.cursor)throw new Error();
   after=z.tuple([z.iso.datetime({precision:6}),z.uuid()]).parse(JSON.parse(decoded.toString('utf8')));
  }catch{throw new FeedbackError(400,'This feedback page reference is invalid.');}
 }
 const rows=(await query(`WITH latest AS (${latestForGame}) SELECT f.id,f.revision_id,f.rules_version,f.agreement,f.rating,f.model_rating,f.comment,f.updated_at,f.is_public,r.number,
 to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
 FROM latest f JOIN analysis_revisions r ON r.id=f.revision_id AND r.game_id=f.game_id
 WHERE f.game_id=$1 AND f.is_public=true AND btrim(f.comment)<>'' ${after?'AND (f.updated_at,f.id)<($3::timestamptz,$4::uuid)':''}
 ORDER BY f.updated_at DESC,f.id DESC LIMIT $2`,after?[gameId,limit+1,...after]:[gameId,limit+1])).rows;
 const page=rows.slice(0,limit),last=page.at(-1);
 return {entries:page.map(row=>({...feedbackFields(row),id:row.id,revisionId:row.revision_id,revisionNumber:row.number,modelRating:row.model_rating,rulesVersion:row.rules_version})),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([last.cursor_updated_at,last.id])).toString('base64url'):null,summary:await getFeedbackSummary(gameId)};
}
/** Operator-only reader includes private comments but never visitor identifiers. */
export async function listVisitorFeedback(limit=50):Promise<VisitorFeedbackRecord[]> {
 const rows=(await query(`SELECT f.id,f.game_id,f.revision_id,f.rules_version,f.agreement,f.rating,f.model_rating,f.comment,f.updated_at,f.is_public,r.number
 FROM visitor_feedback f JOIN analysis_revisions r ON r.id=f.revision_id ORDER BY f.updated_at DESC LIMIT $1`,[Math.min(100,Math.max(1,Number.isInteger(limit)?limit:50))])).rows;
 return rows.map(row=>({...feedbackFields(row),id:row.id,gameId:row.game_id,revisionId:row.revision_id,revisionNumber:row.number,modelRating:row.model_rating,rulesVersion:row.rules_version}));
}
