import { buildAutoPostPreview, getPublishingReadiness } from '@under-review/core/publishing';
import type { GameCard } from '@under-review/core/contracts';
import { dateTime } from '@/lib/presentation';

export async function PublishingReadiness({games}:{games:GameCard[]}){
 let readiness:Awaited<ReturnType<typeof getPublishingReadiness>>;
 try{readiness=await getPublishingReadiness();}catch{return <div className="notice">X setup status is temporarily unavailable.</div>;}
 let preview:Awaited<ReturnType<typeof buildAutoPostPreview>>|null=null;
 for(const game of games.slice(0,3)){try{preview=await buildAutoPostPreview(game.id);break;}catch{}}
 return <div className="publishing-readiness admin-columns equal">
  <div className="admin-panel"><h3>{readiness.automaticReady?'Automatic posts are ready':'Set up automatic game posts'}</h3>
   <p>Account: <strong>{readiness.expectedAccount?`@${readiness.expectedAccount}`:readiness.selectedAccount?`@${readiness.selectedAccount.username}`:'Choose your X account'}</strong></p>
   <p className="small muted">One post when a new game has its first complete rating. Only games kicking off after activation qualify. Later report revisions need a manual update or correction post.</p>
   {readiness.blockers.length>0&&<ul className="publishing-checklist">{readiness.blockers.map(blocker=><li key={blocker}>{blocker}</li>)}</ul>}
   {readiness.settings.activatedAt&&<p className="small">Current kickoff cutoff: {dateTime(readiness.settings.activatedAt)}</p>}
   <details><summary>X developer app settings</summary><p className="small">Use a Web App / Automated App &amp; Bot with Read and Write permission. Save its OAuth 2.0 client ID and secret in the server environment, then connect the intended account below.</p><label>Callback URL<input readOnly value={readiness.callbackUrl}/></label><p className="small muted">Authorization requests tweet.read, tweet.write, users.read and offline.access. Credentials never belong in source control.</p></details>
  </div>
  <div className="admin-panel"><h3>Example game post</h3>{preview?<><p className="draft-text">{preview.text}</p><p className="small muted">Preview only. {preview.ineligibilityReason||'This game meets the upcoming-game cutoff.'}</p><a className="small" href={preview.reportUrl}>Open this report ↗</a></>:<p className="muted">A scored game will appear here as a preview.</p>}</div>
 </div>;
}
