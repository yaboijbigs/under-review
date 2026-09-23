import Link from 'next/link';
import { listVisitorFeedback } from '@under-review/core/visitor-feedback';
import { SUSPICION_SCALE } from '@under-review/core/consumer-summary';
import { dateTime } from '@/lib/presentation';

export async function VisitorFeedbackAdmin(){
  let responses:Awaited<ReturnType<typeof listVisitorFeedback>>;
  try{responses=await listVisitorFeedback(50);}catch{return <section id="visitor-feedback" className="report-section"><h2>Visitor feedback</h2><p>Feedback is temporarily unavailable.</p></section>;}
  return <section id="visitor-feedback" className="report-section"><div className="section-heading"><div><p className="eyebrow">FROM THE FANS</p><h2>Visitor feedback</h2></div><span className="section-caption">Latest 50 responses · visibility shown per response</span></div>{responses.length?<div className="visitor-feedback-list">{responses.map(response=><article key={response.id}><div className="visitor-feedback-top"><Link prefetch={false} href={`/games/${response.gameId}?revision=${response.revisionNumber}`}>{response.gameId} · version {response.revisionNumber}</Link><span>{response.agreement==='agree'?'Agrees':'Disagrees'} · {response.public?'Public':'Private'}</span></div><p>Site: <strong>{SUSPICION_SCALE[response.modelRating-1].label}</strong> · Visitor: <strong>{response.rating===null?'Thumb only':SUSPICION_SCALE[response.rating-1].label}</strong></p>{response.comment&&<p className="visitor-comment">{response.comment}</p>}<time>{dateTime(response.updatedAt)}</time></article>)}</div>:<p>No visitor feedback yet.</p>}</section>;
}
