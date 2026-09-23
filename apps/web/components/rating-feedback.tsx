"use client";

import { useEffect,useId,useRef,useState,type FormEvent } from "react";
import { SUSPICION_SCALE } from "@under-review/core/consumer-summary";

type Rating=1|2|3|4|5;
type Agreement="agree"|"disagree";
type SavedFeedback={agreement:Agreement;rating:Rating;comment:string};
type Summary={total:number;agree:number;disagree:number};
export interface RatingFeedbackProps {gameId:string;revisionId:string;revisionNumber:number;rating:Rating;rulesVersion:string}
async function readResponse(response:Response){let data;try{data=await response.json();}catch{throw new Error('Feedback is temporarily unavailable. Please try again.');}if(!response.ok)throw new Error(data.error||'Feedback is temporarily unavailable. Please try again.');return data;}
const errorMessage=(reason:unknown)=>reason instanceof TypeError?'Could not connect to feedback. Please try again.':reason instanceof Error?reason.message:'Feedback is temporarily unavailable. Please try again.';

export function RatingFeedback({gameId,revisionId,revisionNumber,rating:modelRating,rulesVersion}:RatingFeedbackProps){
 const id=useId();const [agreement,setAgreement]=useState<Agreement|null>(null),[rating,setRating]=useState<Rating>(modelRating),[comment,setComment]=useState('');
 const [ready,setReady]=useState(false),[saving,setSaving]=useState(false),[saved,setSaved]=useState<SavedFeedback|null>(null),[summary,setSummary]=useState<Summary|null>(null),[error,setError]=useState('');
 const [loadAttempt,setLoadAttempt]=useState(0);
 const endpoint=`/api/games/${encodeURIComponent(gameId)}/feedback`;
 const reportKey=`${gameId}:${revisionId}:${rulesVersion}`,loadedReport=useRef(reportKey),edited=useRef(false);
 useEffect(()=>{
  const controller=new AbortController();setReady(false);setError('');
  if(loadedReport.current!==reportKey){loadedReport.current=reportKey;edited.current=false;setAgreement(null);setRating(modelRating);setComment('');setSaved(null);setSummary(null);}
  fetch(`${endpoint}?revisionId=${encodeURIComponent(revisionId)}&rulesVersion=${encodeURIComponent(rulesVersion)}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
   const data=await readResponse(response);
   if(data.feedback){setSaved(data.feedback);setSummary(data.summary);if(!edited.current){setAgreement(data.feedback.agreement);setRating(data.feedback.rating);setComment(data.feedback.comment);}}
   setReady(true);
  }).catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason));});
  return ()=>controller.abort();
 },[endpoint,revisionId,rulesVersion,modelRating,reportKey,loadAttempt]);
 const unchanged=saved?.agreement===agreement&&saved.rating===rating&&saved.comment===comment.trim();
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!agreement||!ready||saving)return;setSaving(true);setError('');
  try{
   const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({revisionId,rulesVersion,agreement,rating,modelRating,comment})});
   const data=await readResponse(response);
   setSaved(data.feedback);setComment(data.feedback.comment);setSummary(data.summary);
  }catch(reason){setError(errorMessage(reason));}
  finally{setSaving(false);}
 }
 return <section className="rating-feedback" aria-labelledby={`${id}-title`} data-report-version={revisionNumber}>
  <div><h3 id={`${id}-title`}>Do you agree with this rating?</h3><p>Your take helps us improve the analysis.</p></div>
  <div className="feedback-choices" aria-label="Agreement with the game rating">
   {(['agree','disagree'] as const).map(value=><button key={value} type="button" className="feedback-choice" aria-pressed={agreement===value} disabled={saving} onClick={()=>{edited.current=true;setAgreement(value);}}><span aria-hidden="true">{value==='agree'?'👍':'👎'}</span> {value==='agree'?'Agree':'Disagree'}</button>)}
  </div>
  {agreement && <form className="feedback-form" onSubmit={submit}>
   <label htmlFor={`${id}-rating`}>How would you rate this game? <strong>{SUSPICION_SCALE[rating-1].label} · {rating}/5</strong></label>
   <input className="feedback-slider" id={`${id}-rating`} name="rating" type="range" min="1" max="5" step="1" value={rating} onChange={event=>{edited.current=true;setRating(Number(event.target.value) as Rating);}} aria-valuetext={`${SUSPICION_SCALE[rating-1].label}, ${rating} of 5`} disabled={saving}/>
   <div className="feedback-labels" aria-hidden="true">{SUSPICION_SCALE.map(tier=><span key={tier.level} data-selected={tier.rating===rating}>{tier.label}</span>)}</div>
   <label htmlFor={`${id}-comment`}>Why? <span>(optional)</span></label><textarea id={`${id}-comment`} name="comment" value={comment} maxLength={1000} rows={3} onChange={event=>{edited.current=true;setComment(event.target.value);}} placeholder="Which plays or patterns shaped your view? Please leave out personal information." disabled={saving}/>
   <p className="small muted">Your explanation is private to the site’s reviewers.</p>
   <div className="feedback-actions"><button className="button dark" type="submit" disabled={!ready||saving||unchanged}>{saving?'Saving…':saved?'Update feedback':'Send feedback'}</button><span className="small muted">{comment.length}/1,000</span></div>
  </form>}
  {saved && unchanged && !error && <p className="feedback-status" role="status">Thanks—your feedback is saved. You can update it here.</p>}
  {saved && summary && <p className="feedback-summary">For this report version: {summary.agree} agree · {summary.disagree} disagree · {summary.total} {summary.total===1?'response':'responses'}.</p>}
  {error && <p className="feedback-error" role="alert">{error}</p>}
  {!ready&&error&&<button className="button outline" type="button" onClick={()=>setLoadAttempt(value=>value+1)}>Try feedback again</button>}
  {!ready&&!error&&agreement&&<p className="feedback-status" role="status">Getting feedback ready…</p>}
 </section>;
}
