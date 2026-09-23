import { consumeRateLimit,trustedOrigin } from '@under-review/core/auth';
import { log } from '@under-review/core/config';
import { createFeedbackToken,feedbackVisitorId,feedbackCookie,feedbackTokenFromRequest,feedbackClientKey,getVisitorFeedback,saveVisitorFeedback,getFeedbackSummary,parseFeedbackRevision,parseFeedbackSubmission,FeedbackError } from '@under-review/core/visitor-feedback';

export const dynamic='force-dynamic';
type Context={params:Promise<{gameId:string}>};
const respond=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie',...headers}});
function failed(error:unknown){if(error instanceof FeedbackError)return respond({error:error.message},error.status);log('visitor-feedback.failed',{error});return respond({error:'Feedback is temporarily unavailable. Please try again.'},503);}
async function bodyJson(request:Request):Promise<unknown> {
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new FeedbackError(415,'Send feedback as JSON.');
 if(Number(request.headers.get('content-length')??0)>8192)throw new FeedbackError(413,'The feedback request is too large.');
 const reader=request.body?.getReader();if(!reader)throw new FeedbackError(400,'Feedback is missing.');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw new FeedbackError(413,'The feedback request is too large.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new FeedbackError(400,'Feedback could not be read. Please try again.');}
}
export async function GET(request:Request,{params}:Context){
 const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
 if((origin&&!trustedOrigin(origin))||(site&&site!=='same-origin'&&site!=='none'))return respond({error:'Invalid origin.'},403);
 try{
  const {gameId}=await params,url=new URL(request.url);const reference=parseFeedbackRevision({revisionId:url.searchParams.get('revisionId'),rulesVersion:url.searchParams.get('rulesVersion')});
  if(!await consumeRateLimit(feedbackClientKey(request)+':read',120,60))return respond({error:'Please wait a moment before trying again.'},429,{'Retry-After':'60'});
  let token=feedbackTokenFromRequest(request),visitorId=feedbackVisitorId(token);let cookie:string|undefined;
  if(!visitorId){token=createFeedbackToken();visitorId=feedbackVisitorId(token)!;cookie=feedbackCookie(token);}
  const feedback=await getVisitorFeedback(gameId,reference.revisionId,reference.rulesVersion,visitorId);
  const summary=feedback?await getFeedbackSummary(gameId,reference.revisionId,reference.rulesVersion):null;
  return respond({feedback,summary},200,cookie?{'Set-Cookie':cookie}:{});
 }catch(error){return failed(error);}
}
export async function POST(request:Request,{params}:Context){
 if(!trustedOrigin(request.headers.get('origin')))return respond({error:'Invalid origin.'},403);
 try{
  const input=parseFeedbackSubmission(await bodyJson(request));const visitorId=feedbackVisitorId(feedbackTokenFromRequest(request));
  if(!visitorId)return respond({error:'Please reload the report to enable feedback.'},401);
  if(!await consumeRateLimit(feedbackClientKey(request)+':write',30,60)||!await consumeRateLimit('feedback:visitor:'+visitorId,12,60))return respond({error:'Please wait a minute before updating your feedback again.'},429,{'Retry-After':'60'});
  const {gameId}=await params,feedback=await saveVisitorFeedback(gameId,visitorId,input);
  const summary=await getFeedbackSummary(gameId,input.revisionId,input.rulesVersion);
  return respond({feedback,summary});
 }catch(error){return failed(error);}
}
