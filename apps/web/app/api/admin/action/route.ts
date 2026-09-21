import { cookies } from 'next/headers';
import { getSession,trustedOrigin,validCsrf,consumeRateLimit } from '@under-review/core/auth';
import { config,safeError } from '@under-review/core/config';
import { query,audit } from '@under-review/core/db';
import { enqueue } from '@under-review/core/jobs';
import { createDraft,approveDraft,setPublishing,setKillSwitch,beginXConnection,reconcilePublication } from '@under-review/core/publishing';
import { saveReview,approveReview,insertMissedEvent } from '@under-review/core/reviews';
export async function POST(request:Request){
 const session=await getSession((await cookies()).get('ur_session')?.value);
 if(!session||!trustedOrigin(request.headers.get('origin')))return new Response('Forbidden',{status:403});
 const body=await request.text();if(body.length>20000)return new Response('Request too large',{status:413});
 const form=new URLSearchParams(body);if(!validCsrf(session,form.get('csrf')))return new Response('Forbidden',{status:403});
 if(!await consumeRateLimit('mutation:'+session.userId,120,60))return new Response('Rate limited',{status:429});
 const action=form.get('action')??'';const get=(key:string)=>form.get(key)??'';
 if(!['save-review','insert-event'].includes(action)&&session.role!=='admin')return new Response('Administrator required',{status:403});
 try{
  switch(action){
   case 'enqueue-analysis':if(!(await query('SELECT 1 FROM games WHERE id=$1',[get('gameId')])).rowCount)throw new Error('Unknown game');await enqueue('analyze',get('gameId'),{preferRaw:false});await audit(session.userId,'analysis.queued',get('gameId'));break;
   case 'save-review':await saveReview({...Object.fromEntries(form),replayCorrected:get('replayCorrected')==='true',scopeComplete:get('scopeComplete')==='true'},session);break;
   case 'approve-review':await approveReview(get('reviewId'),session);break;
   case 'insert-event':await insertMissedEvent({gameId:get('gameId'),playId:get('playId'),description:get('description'),team:get('team')||null},session);break;
   case 'draft':await createDraft(get('gameId'));await audit(session.userId,'draft.created',get('gameId'));break;
   case 'approve-draft':await approveDraft(get('outboxId'),session.userId);break;
   case 'reconcile-publication':{const resolution=get('resolution');if(resolution!=='posted'&&resolution!=='cancel')throw new Error('Choose an existing post or permanent cancellation.');await reconcilePublication(get('outboxId'),resolution,get('externalId')||null,session.userId);break;}
   case 'set-publishing':{const mode=get('mode');if(!['off','draft-only','automatic'].includes(mode))throw new Error('Invalid mode');if(mode==='automatic'&&get('confirmAutomatic')!=='yes')throw new Error('Explicit account-bound automatic-posting confirmation required.');await setPublishing(mode as 'off'|'draft-only'|'automatic',get('accountId')||null,session.userId);break;}
   case 'kill-switch':if(!['true','false'].includes(get('enabled')))throw new Error('Invalid setting');await setKillSwitch(get('enabled')==='true',session.userId);break;
   case 'x-connect':return Response.redirect(await beginXConnection(session.userId),303);
   default:throw new Error('Unknown action');
  }
  return Response.redirect(new URL('/admin?message=Action+recorded',config.siteUrl),303);
 }catch(error){return Response.redirect(new URL('/admin?error='+encodeURIComponent(safeError(error)),config.siteUrl),303);}
}
