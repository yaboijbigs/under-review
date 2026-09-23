import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { query } from './db.js';
import { config } from './config.js';
import { getGameVerdict,SUSPICION_RULES_VERSION } from './consumer-summary.js';
import type { GameAudit } from './contracts.js';

export const FEEDBACK_COOKIE='ur_feedback';
export const FEEDBACK_COMMENT_LIMIT=1000;
export type FeedbackRating=1|2|3|4|5;
export interface VisitorFeedback {agreement:'agree'|'disagree';rating:FeedbackRating;comment:string;updatedAt:string}
export interface VisitorFeedbackRecord extends VisitorFeedback {id:string;gameId:string;revisionId:string;revisionNumber:number;modelRating:FeedbackRating;rulesVersion:string}
export interface FeedbackSummary {total:number;agree:number;disagree:number;ratings:{rating:FeedbackRating;count:number}[]}
export class FeedbackError extends Error {constructor(public status:number,message:string){super(message);}}
const revisionSchema=z.object({revisionId:z.uuid(),rulesVersion:z.literal(SUSPICION_RULES_VERSION)});
const submissionSchema=revisionSchema.extend({agreement:z.enum(['agree','disagree']),rating:z.number().int().min(1).max(5),modelRating:z.number().int().min(1).max(5),comment:z.string().max(FEEDBACK_COMMENT_LIMIT).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)).transform(value=>value.replaceAll('\r\n','\n').trim())}).strict();
export type FeedbackSubmission=z.infer<typeof submissionSchema>;
function currentRules(input:unknown){if(input&&typeof input==='object'&&'rulesVersion' in input&&typeof input.rulesVersion==='string'&&input.rulesVersion!==SUSPICION_RULES_VERSION)throw new FeedbackError(409,'The rating rules have changed. Reload the report before sending feedback.');}
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
function publicFeedback(row:Record<string,any>):VisitorFeedback {return {agreement:row.agreement,rating:row.rating,comment:row.comment,updatedAt:new Date(row.updated_at).toISOString()};}
export async function getVisitorFeedback(gameId:string,revisionId:string,rulesVersion:string,visitorId:string):Promise<VisitorFeedback|null> {
 validGameId(gameId);parseFeedbackRevision({revisionId,rulesVersion});
 const row=(await query('SELECT agreement,rating,comment,updated_at FROM visitor_feedback WHERE game_id=$1 AND revision_id=$2 AND rules_version=$3 AND visitor_id=$4',[gameId,revisionId,rulesVersion,visitorId])).rows[0];
 return row?publicFeedback(row):null;
}
export async function saveVisitorFeedback(gameId:string,visitorId:string,input:unknown):Promise<VisitorFeedback> {
 validGameId(gameId);if(!/^[a-f0-9]{64}$/.test(visitorId))throw new FeedbackError(401,'Please reload the report before sending feedback.');
 const submission=parseFeedbackSubmission(input);
 const revision=(await query('SELECT analysis->\'gameAudit\' AS audit FROM analysis_revisions WHERE id=$1 AND game_id=$2',[submission.revisionId,gameId])).rows[0];
 if(!revision)throw new FeedbackError(404,'This report version is unavailable. Reload the report and try again.');
 const verdict=getGameVerdict(revision.audit as GameAudit|undefined);
 if(verdict.rating===null||verdict.rulesVersion!==submission.rulesVersion||verdict.rating!==submission.modelRating)throw new FeedbackError(409,'The rating has changed or is unavailable. Reload the report before sending feedback.');
 const row=(await query(`INSERT INTO visitor_feedback(id,game_id,revision_id,rules_version,visitor_id,agreement,rating,model_rating,comment)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT(game_id,revision_id,rules_version,visitor_id) DO UPDATE SET agreement=EXCLUDED.agreement,rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=now()
 RETURNING agreement,rating,comment,updated_at`,[randomUUID(),gameId,submission.revisionId,submission.rulesVersion,visitorId,submission.agreement,submission.rating,verdict.rating,submission.comment])).rows[0];
 return publicFeedback(row);
}
export async function getFeedbackSummary(gameId:string,revisionId:string,rulesVersion:string):Promise<FeedbackSummary> {
 validGameId(gameId);parseFeedbackRevision({revisionId,rulesVersion});
 const rows=(await query('SELECT agreement,rating,count(*)::integer AS count FROM visitor_feedback WHERE game_id=$1 AND revision_id=$2 AND rules_version=$3 GROUP BY agreement,rating',[gameId,revisionId,rulesVersion])).rows;
 const summary:FeedbackSummary={total:0,agree:0,disagree:0,ratings:([1,2,3,4,5] as const).map(rating=>({rating,count:0}))};
 for(const row of rows){summary.total+=row.count;summary[row.agreement as 'agree'|'disagree']+=row.count;summary.ratings[row.rating-1].count+=row.count;}
 return summary;
}
/** Operator-only reader. Do not expose comments or visitor identifiers through public routes. */
export async function listVisitorFeedback(limit=50):Promise<VisitorFeedbackRecord[]> {
 const rows=(await query(`SELECT f.id,f.game_id,f.revision_id,f.rules_version,f.agreement,f.rating,f.model_rating,f.comment,f.updated_at,r.number
 FROM visitor_feedback f JOIN analysis_revisions r ON r.id=f.revision_id ORDER BY f.updated_at DESC LIMIT $1`,[Math.min(100,Math.max(1,Number.isInteger(limit)?limit:50))])).rows;
 return rows.map(row=>({...publicFeedback(row),id:row.id,gameId:row.game_id,revisionId:row.revision_id,revisionNumber:row.number,modelRating:row.model_rating,rulesVersion:row.rules_version}));
}
