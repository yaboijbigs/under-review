import type { AnalysisResult } from "@under-review/core/contracts";

export function SourcePlays({plays, home}: {plays: AnalysisResult["timeline"]; home: string}) {
  return <section id="source-plays" className="report-section source-play-section">
    <div className="section-heading"><div><p className="eyebrow">THE UNDERLYING RECORD</p><h2>Source plays <span className="count">{plays.length}</span></h2></div></div>
    <p className="small muted">Full play descriptions from this revision, including plays without a modeled event. A source description records the published outcome; it does not resolve whether a ruling was correct.</p>
    {plays.length ? <details className="source-play-archive"><summary>Browse all {plays.length} source plays</summary>
      <div className="source-play-list">{plays.map((play, index) => <details className="source-play" id={`play-${play.playId}`} key={`${play.playId}:${index}`}>
        <summary><span className="source-play-time">{play.quarter ? `Q${play.quarter}` : "Period unavailable"}<strong>{play.clock || "Clock unavailable"}</strong></span><span className="source-play-preview">{play.description || "Source description unavailable"}</span><span className="source-play-id">Play {play.playId}</span></summary>
        <div className="source-play-body"><p>{play.description || "Source description unavailable"}</p><div className="source-play-meta"><span>Source play {play.playId}</span><span>{play.homeWp === null ? "Preplay win probability unavailable" : `${home} preplay win probability: ${(play.homeWp * 100).toFixed(1)}%`}</span><a href={`#play-${encodeURIComponent(play.playId)}`}>Link to source play ↗</a></div></div>
      </details>)}</div>
    </details> : <p className="small muted">This revision has no source-play record.</p>}
  </section>;
}
