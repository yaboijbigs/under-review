import { consumeRateLimit } from '@under-review/core/auth';
import { log } from '@under-review/core/config';
import { feedbackClientKey,listPublicVisitorFeedback,FeedbackError } from '@under-review/core/visitor-feedback';

export const dynamic='force-dynamic';
type Context={params:Promise<{gameId:string}>};
const respond=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});

/** Cookie-free reader of explicitly public submissions only. Never initializes a visitor. */
export async function GET(request:Request,{params}:Context){
 try{
  if(!await consumeRateLimit(feedbackClientKey(request)+':public-read',120,60))return respond({error:'Please wait a moment before trying again.'},429,{'Retry-After':'60'});
  const {gameId}=await params,url=new URL(request.url),size=url.searchParams.get('limit');
  const page=await listPublicVisitorFeedback(gameId,{limit:size===null?20:Number(size),cursor:url.searchParams.get('cursor')});
  return respond(page);
 }catch(error){
  if(error instanceof FeedbackError)return respond({error:error.message},error.status);
  log('visitor-feedback.public-read-failed',{error});return respond({error:'Public feedback is temporarily unavailable. Please try again.'},503);
 }
}
