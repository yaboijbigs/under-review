import type { GameAudit } from '@under-review/core/contracts';
import { getGameRatingBreakdown } from '@under-review/core/consumer-summary';

const percent=(value:number)=>new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:2}).format(value);

export function RatingBreakdown({audit}:{audit:GameAudit|undefined}) {
  const breakdown=getGameRatingBreakdown(audit);
  return <details className="rating-breakdown">
    <summary>How this rating was calculated</summary>
    <div className="rating-breakdown-body">
      {breakdown.status==='available'?<>
        <p className="rating-calculation-result">{breakdown.summary}</p>
        <div className="rating-factor-grid">{breakdown.families.map(family=><article className="rating-factor" key={family.id} data-factor={family.id} data-rating={family.eligibleRating??'unavailable'}>
          <div className="rating-factor-heading"><h3>{family.title}</h3><span>{family.status==='context'?'Comparison':family.eligibleRating===null?'Unavailable':`${family.eligibleLabel} · ${family.eligibleRating}/5`}</span></div>
          {family.evidence.map((line,index)=><p key={index}>{line}</p>)}
          {family.adjustedTailProbability!==null&&<p className="rating-factor-rarity">{family.rarityLabel??'Adjusted rarity'}: <strong>{percent(family.adjustedTailProbability)}</strong></p>}
        </article>)}</div>
        <p className="rating-combination">{breakdown.combinationRule}</p>
        {breakdown.corroboration&&<p className="rating-corroboration">{breakdown.corroboration.explanation}</p>}
        <details className="rating-thresholds"><summary>Rating thresholds</summary>
          <ul>{breakdown.thresholds.map(threshold=><li key={threshold.rating}><strong>{threshold.label} · {threshold.rating}/5:</strong> {(breakdown.thresholdLabel??'Adjusted rarity').toLowerCase()} at or below {percent(threshold.adjustedTailAtMost)}.</li>)}</ul>
          {breakdown.notes.map((note,index)=><p key={index}>{note}</p>)}
          <a href="/methodology#verdicts">Full methodology ↗</a>
        </details>
      </>:<><p>{breakdown.summary}</p><a href="/methodology#verdicts">Rating methodology ↗</a></>}
    </div>
  </details>;
}
