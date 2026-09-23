"use client";

import { useEffect,useId,useRef,useState,type FormEvent } from "react";
import { SUSPICION_SCALE } from "@under-review/core/consumer-summary";

type Rating=1|2|3|4|5;
type Agreement="agree"|"disagree";
type SavedFeedback={agreement:Agreement;rating:Rating|null;comment:string;public:boolean};
type Summary={total:number;agree:number;disagree:number};
export interface RatingFeedbackProps {gameId:string;revisionId:string;revisionNumber:number;rating:Rating;rulesVersion:string;compact?:boolean;initialCount?:number}
async function readResponse(response:Response){let data;try{data=await response.json();}catch{throw new Error('Feedback is temporarily unavailable. Please try again.');}if(!response.ok)throw new Error(data.error||'Feedback is temporarily unavailable. Please try again.');return data;}
const errorMessage=(reason:unknown)=>reason instanceof TypeError?'Could not connect to feedback. Please try again.':reason instanceof Error?reason.message:'Feedback is temporarily unavailable. Please try again.';

export function RatingFeedback({gameId,revisionId,revisionNumber,rating:modelRating,rulesVersion,compact=false,initialCount=0}:RatingFeedbackProps){
 const id=useId();const [agreement,setAgreement]=useState<Agreement|null>(null),[rating,setRating]=useState<Rating|null>(null),[comment,setComment]=useState('');
 const [ready,setReady]=useState(false),[saving,setSaving]=useState(false),[saved,setSaved]=useState<SavedFeedback|null>(null),[summary,setSummary]=useState<Summary|null>(null),[error,setError]=useState('');
 const [loadAttempt,setLoadAttempt]=useState(0);
 const [activated,setActivated]=useState(!compact);
 const [pendingThumb,setPendingThumb]=useState<Agreement|null>(null),[thumbFailed,setThumbFailed]=useState(false),[count,setCount]=useState(initialCount);
 const endpoint=`/api/games/${encodeURIComponent(gameId)}/feedback`;
 const reportKey=`${gameId}:${revisionId}:${rulesVersion}`,loadedReport=useRef(reportKey),edited=useRef({agreement:false,rating:false,comment:false});
 useEffect(()=>{
  if(!activated)return;
  const controller=new AbortController();setReady(false);setError('');
  if(loadedReport.current!==reportKey){loadedReport.current=reportKey;edited.current={agreement:false,rating:false,comment:false};setAgreement(null);setRating(null);setComment('');setSaved(null);setSummary(null);setPendingThumb(null);setThumbFailed(false);setCount(initialCount);}
  fetch(`${endpoint}?revisionId=${encodeURIComponent(revisionId)}&rulesVersion=${encodeURIComponent(rulesVersion)}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
   const data=await readResponse(response);
   if(data.feedback){setSaved(data.feedback);setSummary(data.summary);if(!edited.current.agreement)setAgreement(data.feedback.agreement);if(!edited.current.rating)setRating(data.feedback.rating);if(!edited.current.comment)setComment(data.feedback.comment);}
   if(data.summary)setCount(data.summary.total);
   setReady(true);
  }).catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason));});
  return ()=>controller.abort();
 },[endpoint,revisionId,rulesVersion,modelRating,reportKey,loadAttempt,activated,initialCount]);
 const unchanged=saved?.public===true&&saved.agreement===agreement&&saved.rating===rating&&saved.comment===comment.trim();
 async function persist(action:'thumb'|'details',choice:Agreement){
  setSaving(true);setError('');setThumbFailed(false);
  try{
   const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({revisionId,rulesVersion,action,agreement:choice,rating:action==='thumb'?null:rating,modelRating,comment:action==='thumb'?'':comment,public:true})});
   const data=await readResponse(response);
   setSaved(data.feedback);setSummary(data.summary);setCount(data.summary.total);
   if(action==='details'||!edited.current.rating)setRating(data.feedback.rating);
   if(action==='details'||!edited.current.comment)setComment(data.feedback.comment);
   window.dispatchEvent(new CustomEvent('under-review:feedback-saved',{detail:{gameId}}));
  }catch(reason){setError(errorMessage(reason));setThumbFailed(action==='thumb');}
  finally{setSaving(false);}
 }
 useEffect(()=>{if(ready&&pendingThumb&&!saving){const choice=pendingThumb;setPendingThumb(null);void persist('thumb',choice);}},[ready,pendingThumb,saving]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!agreement||!ready||saving||pendingThumb)return;await persist('details',agreement);}
 const chooseRating=(value:string)=>{edited.current.rating=true;setRating(Number(value) as Rating);};
 return <section className={`rating-feedback${compact?' rating-feedback-compact':''}`} aria-labelledby={`${id}-title`} data-report-version={revisionNumber}>
  <div className={compact?'sr-only':undefined}><h3 id={`${id}-title`}>Do you agree with this rating?</h3>{!compact&&<p>Share your take with other fans.</p>}</div>
  <div className="feedback-thumb-row"><div className="feedback-choices" aria-label="Agreement with the game rating">
   {(['agree','disagree'] as const).map(value=><button key={value} type="button" className="feedback-choice" aria-label={value==='agree'?'Agree':'Disagree'} title={value==='agree'?'Agree with this rating':'Disagree with this rating'} aria-pressed={agreement===value} aria-describedby={`${id}-public`} aria-controls={`${id}-form`} aria-expanded={agreement!==null} disabled={saving||pendingThumb!==null} onClick={()=>{edited.current.agreement=true;setAgreement(value);setActivated(true);setPendingThumb(value);}}><span aria-hidden="true">{value==='agree'?'👍':'👎'}</span>{!compact&&<> {value==='agree'?'Agree':'Disagree'}</>}</button>)}
  </div><a className="public-feedback-link" href={`/games/${encodeURIComponent(gameId)}#fan-feedback`}>See Public Feedback{compact?` (${count})`:''}</a></div>
  <p id={`${id}-public`} className="small feedback-public-notice">Thumbs are public. One response per browser, per game.</p>
  {agreement && <form className="feedback-form" id={`${id}-form`} onSubmit={submit}>
   <label htmlFor={`${id}-rating`}>How would you rate this game? <strong>{rating===null?'Optional · not selected':`${SUSPICION_SCALE[rating-1].label} · ${rating}/5`}</strong></label>
   <input className="feedback-slider" id={`${id}-rating`} name="rating" type="range" min="1" max="5" step="1" value={rating??3} onChange={event=>chooseRating(event.target.value)} onPointerUp={event=>chooseRating(event.currentTarget.value)} data-chosen={rating!==null} aria-valuetext={rating===null?'No rating selected. Move the slider to add one.':`${SUSPICION_SCALE[rating-1].label}, ${rating} of 5`} disabled={saving}/>
   <div className="feedback-labels" aria-hidden="true">{SUSPICION_SCALE.map(tier=><span key={tier.level} data-selected={tier.rating===rating}>{tier.label}</span>)}</div>
   <label htmlFor={`${id}-comment`}>Why? <span>(optional)</span></label><textarea id={`${id}-comment`} name="comment" value={comment} maxLength={1000} rows={3} onChange={event=>{edited.current.comment=true;setComment(event.target.value);}} placeholder="Which plays or patterns shaped your view? Please leave out personal information." disabled={saving}/>
   {rating!==null&&<button className="feedback-clear-rating" type="button" disabled={saving} onClick={()=>{edited.current.rating=true;setRating(null);}}>Clear optional rating</button>}
   <p className="small muted">Details will be public too. Don’t include personal information.</p>
   {saved&&!saved.public&&<p className="small muted">Your earlier response is private. Submit again to share it publicly.</p>}
   <div className="feedback-actions"><button className="button dark" type="submit" disabled={!ready||saving||pendingThumb!==null||unchanged}>{saving?'Saving…':'Save details'}</button><span className="small muted">{comment.length}/1,000</span></div>
  </form>}
  {saved?.public && !error && !saving && !pendingThumb && <p className="feedback-status" role="status">{unchanged?'Your public response is saved.':'Your thumb is saved. Save any extra details when you’re ready.'}</p>}
  {saved && summary && !compact && <p className="feedback-summary">{summary.agree} agree · {summary.disagree} disagree · {summary.total} {summary.total===1?'response':'responses'}.</p>}
  {error && <p className="feedback-error" role="alert">{error}</p>}
  {!ready&&error&&<button className="button outline" type="button" onClick={()=>setLoadAttempt(value=>value+1)}>Try feedback again</button>}
  {ready&&thumbFailed&&agreement&&<button className="button outline" type="button" onClick={()=>setPendingThumb(agreement)} disabled={saving}>Retry thumb</button>}
  {!ready&&!error&&agreement&&<p className="feedback-status" role="status">Getting feedback ready…</p>}
 </section>;
}
