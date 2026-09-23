"use client";

import { useCallback,useEffect,useState } from 'react';
import type { PublicVisitorFeedback,PublicFeedbackPage,FeedbackSummary } from '@under-review/core/visitor-feedback';
import { SUSPICION_SCALE } from '@under-review/core/consumer-summary';

const postedAt=(value:string)=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value));
export function PublicFeedback({gameId}:{gameId:string}){
 const [entries,setEntries]=useState<PublicVisitorFeedback[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 const [loaded,setLoaded]=useState(false);
 const [summary,setSummary]=useState<FeedbackSummary|null>(null);
 const endpoint=`/api/games/${encodeURIComponent(gameId)}/feedback/public`;
 const read=useCallback(async(cursor:string|null,signal?:AbortSignal)=>{
  const response=await fetch(`${endpoint}?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{cache:'no-store',signal});
  if(!response.ok)throw new Error('Fan feedback is temporarily unavailable. Please try again.');
  try{return await response.json() as PublicFeedbackPage;}catch{throw new Error('Fan feedback is temporarily unavailable. Please try again.');}
 },[endpoint]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');
  read(null,controller.signal).then(data=>{setEntries(data.entries);setNextCursor(data.nextCursor);setSummary(data.summary);setLoaded(true);}).catch(()=>{if(!controller.signal.aborted)setError('Fan feedback is temporarily unavailable. Please try again.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[read,attempt]);
 useEffect(()=>{
  const refresh=(event:Event)=>{if((event as CustomEvent<{gameId:string}>).detail?.gameId===gameId)setAttempt(value=>value+1);};
  window.addEventListener('under-review:feedback-saved',refresh);return()=>window.removeEventListener('under-review:feedback-saved',refresh);
 },[gameId]);
 async function more(){
  if(!nextCursor||loading)return;setLoading(true);setError('');
  try{const data=await read(nextCursor);setEntries(current=>{const known=new Set(current.map(entry=>entry.id));return [...current,...data.entries.filter(entry=>!known.has(entry.id))];});setNextCursor(data.nextCursor);setSummary(data.summary);}
  catch{setError('Fan feedback is temporarily unavailable. Please try again.');}finally{setLoading(false);}
 }
 return <section id="fan-feedback" className="report-section public-feedback" aria-labelledby="fan-feedback-title">
  <div className="section-heading"><div><p className="eyebrow">FROM THE FANS</p><h2 id="fan-feedback-title">Fan feedback</h2></div><span className="section-caption">How other fans saw this game.</span></div>
  {summary&&<div className="public-feedback-summary" aria-label="Public feedback totals"><div><strong>{summary.total}</strong><span>{summary.total===1?'response':'responses'}</span></div><div><strong>{summary.agree}</strong><span>Agree</span></div><div><strong>{summary.disagree}</strong><span>Disagree</span></div><div><strong>{summary.averageRating===null?'—':`${summary.averageRating.toFixed(1)} / 5`}</strong><span>Average rating</span><small>{summary.ratingCount?`From ${summary.ratingCount} slider ${summary.ratingCount===1?'rating':'ratings'}`:'No slider ratings yet'}</small></div></div>}
  {entries.length>0&&<div className="visitor-feedback-list">{entries.map(entry=><article key={entry.id}>
   <div className="visitor-feedback-top"><strong>{entry.rating===null?'No slider rating':`${SUSPICION_SCALE[entry.rating-1].label} · ${entry.rating}/5`}</strong><span>{entry.agreement==='agree'?'Agrees':'Disagrees'} with {SUSPICION_SCALE[entry.modelRating-1].label}</span></div>
   <p className="visitor-comment">{entry.comment}</p>
   <div className="public-feedback-meta"><span>Anonymous fan</span><time dateTime={entry.updatedAt}>{postedAt(entry.updatedAt)}</time><a href={`/games/${encodeURIComponent(gameId)}?revision=${entry.revisionNumber}`}>Report version {entry.revisionNumber}</a></div>
  </article>)}</div>}
  {loaded&&!loading&&!error&&entries.length===0&&<p className="feedback-empty">No comments yet. Be the first to share your take.</p>}
  {loading&&<p className="small muted" role="status">Loading fan feedback…</p>}
  {error&&<div className="public-feedback-error"><p role="alert">{error}</p><button className="button outline" type="button" onClick={()=>nextCursor&&loaded?void more():setAttempt(value=>value+1)} disabled={loading}>Try again</button></div>}
  {nextCursor&&!error&&<button className="button outline" type="button" onClick={()=>void more()} disabled={loading}>Show more feedback</button>}
 </section>;
}
