import Link from "next/link";
import type { ReactNode } from "react";
import type { GameCard as CardData, Metric, EvidenceEvent, Review, AnalysisResult } from "@under-review/core/contracts";
import { getGameVerdict } from "@under-review/core/consumer-summary";
import { dateTime, first, gameView, human, num, record, records, safeLink, statusTone, str, teamName, type RecordValue } from "@/lib/presentation";
import { RatingFeedback } from "@/components/rating-feedback";

export function Status({value, label}: {value: unknown; label?: string}) { return <span className={`status ${statusTone(value)}`}><span aria-hidden="true" />{label || human(value)}</span>; }
export function PageIntro({eyebrow, title, children}: {eyebrow: string; title: string; children?: ReactNode}) { return <div className="page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children && <div className="intro-copy">{children}</div>}</div>; }
export function EmptyState({title, children, compact = false}: {title: string; children: ReactNode; compact?: boolean}) { return <div className={`empty-state ${compact ? "compact" : ""}`}><span className="empty-mark" aria-hidden="true">∅</span><h2>{title}</h2><div>{children}</div></div>; }
export function Unavailable({children}: {children?: ReactNode}) { return <div className="notice"><span className="notice-icon" aria-hidden="true">!</span><div><strong>Data connection unavailable</strong><p>{children || "The report archive is temporarily unavailable. No results have been substituted. Please try again shortly."}</p></div></div>; }
export function GameCard({game}: {game: CardData}) {
  const verdict = getGameVerdict(game.gameAudit, game.revisionNumber !== null);
  const href = `/games/${encodeURIComponent(game.id)}`;
  return <article className={`game-card verdict-${verdict.tone}`} data-verdict={verdict.level} data-rating={verdict.rating ?? "unrated"}>
    <div className="card-top"><span>WEEK {game.week} <span className="muted">/ {game.season}</span></span>{game.revisionNumber === null && <span>Awaiting game data</span>}</div>
    <p className="card-rating-label">GAME RATING <span>{verdict.rating ? `${verdict.rating} / 5` : "—"}</span></p>
    <div className="card-verdict"><span className="verdict-indicator" aria-hidden="true"/><h3><Link prefetch={false} href={href}>{verdict.label}</Link></h3></div>
    <Link prefetch={false} className="scoreboard-link" href={href} aria-label={`Read ${teamName(game.awayTeam)} at ${teamName(game.homeTeam)} report`}>
      {[{team:game.awayTeam,score:game.awayScore},{team:game.homeTeam,score:game.homeScore}].map(({team,score}) => <div className="score-row" key={team}><span className="team-monogram" aria-hidden="true">{team}</span><span className="team-full-name">{teamName(team)}</span><strong>{score ?? "—"}</strong></div>)}
    </Link>
    <div className="card-finding"><p>{verdict.rating && verdict.rating <= 2 ? verdict.summary : verdict.reasons[0] || verdict.summary}</p></div>
    <div className="card-bottom"><span>{verdict.reviewCount ? `${verdict.reviewCount} key ${verdict.reviewCount === 1 ? "play" : "plays"}` : ""}</span><Link prefetch={false} href={href}>See why <span aria-hidden="true">↗</span></Link></div>
    {verdict.rating&&game.revisionId&&game.revisionNumber&&<RatingFeedback key={`${game.revisionId}:${verdict.rulesVersion}`} compact gameId={game.id} revisionId={game.revisionId} revisionNumber={game.revisionNumber} rating={verdict.rating} rulesVersion={verdict.rulesVersion}/>}
  </article>;
}
export function Freshness({value, label = "Last processed"}: {value: unknown; label?: string}) { return <span className="freshness">{label} <time>{dateTime(value)}</time></span>; }
export function DefinitionRows({value}: {value: unknown}) {
  const data = record(value); const items = Object.entries(data).filter(([, v]) => v !== undefined);
  return items.length ? <dl className="definition-rows">{items.map(([key, val]) => <div key={key}><dt>{human(key)}</dt><dd>{val === null ? "Unavailable" : typeof val === "object" ? <code>{JSON.stringify(val)}</code> : String(val)}</dd></div>)}</dl> : <p className="muted">State not available.</p>;
}
export function Evidence({event, metrics, reviews}: {event: EvidenceEvent; metrics: Metric[]; reviews: Review[]}) {
  return <details className="evidence" id={`event-${event.id}`}><summary><span className="event-time">{event.quarter ? `Q${event.quarter}` : "PLAY"}<strong>{event.clock || event.playId}</strong></span><span className="event-title"><strong>{human(event.kind, "Recorded event")}{event.team ? ` · ${event.team}` : ""}</strong><span>{event.description}</span></span><span className="expand-sign" aria-hidden="true">+</span></summary><div className="evidence-body"><div className="evidence-meta"><Status value={event.reviewStatus}/><span>Play {event.playId}</span><a href={`#event-${event.id}`}>Link to event</a></div>{event.notes && event.notes.length > 0 && <div className="assumptions"><h4>Event notes</h4><ul>{event.notes.map((note,index) => <li key={index}>{note}</li>)}</ul></div>}{metrics.length ? metrics.map(metric => <section className="event-metric" key={metric.id}><h4>{human(metric.name)} <span className="muted">{metric.team}</span></h4><p><MetricValue metric={metric}/> <Status value={metric.status}/></p><div className="state-pair"><section><h4>Actual state</h4><DefinitionRows value={metric.actualState}/></section><section><h4>Supported alternative</h4>{metric.alternativeState ? <DefinitionRows value={metric.alternativeState}/> : <p className="muted">No supported alternative state. Observed play impact is not an estimate of error cost.</p>}</section></div>{metric.assumptions.length > 0 && <div className="assumptions"><h4>Assumptions</h4><ul>{metric.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}<p className="small muted">Model {metric.modelVersion} · {metric.coverage.modeled}/{metric.coverage.eligible} eligible events modeled</p></section>) : <p className="muted">This event has no supported modeled impact. Its observed result alone does not establish the cost of an error.</p>}{reviews.map(review => <div className="review-note" key={review.id}><Status value={review.status}/>{review.stale && <Status value="stale" label="Review predates corrected inputs"/>}<p>{review.rationale}</p><p className="small">{review.reviewer} · {review.confidence} confidence · {review.approved ? "Approved" : "Not approved"}{review.replayCorrected ? " · Corrected by replay" : ""}</p><p className="small">Rule {review.ruleSeason}: {review.ruleReference}<br/>Review scope: {review.scope}<br/>Scope completion: {review.scopeComplete ? review.approved && !review.stale ? "Attested and administrator-approved for this stated scope only." : "Reviewer-attested; not a current approved completion." : "Not attested."}</p>{safeLink(review.evidenceUrl) && <a href={safeLink(review.evidenceUrl)} target="_blank" rel="noreferrer">Review evidence ↗</a>}</div>)}</div></details>;
}
export function MetricValue({metric}: {metric: Metric}) {
  if (metric.value === null || metric.status === "unavailable") return <span className="metric-unavailable">Unavailable</span>;
  const probability = ["wp", "probability", "wp_delta"].includes(metric.unit); const value = probability ? metric.value * 100 : metric.value;
  const unit = metric.unit === "wp_delta" ? "percentage points" : probability ? "%" : metric.unit.replace(/_/g, " ");
  return <span className="metric-value">{new Intl.NumberFormat("en-US", {maximumFractionDigits: Number.isInteger(value) ? 0 : 2, signDisplay: "auto"}).format(value)} <small>{unit}{metric.status === "experimental" ? " · experimental" : ""}</small></span>;
}
export function MetricRarity({metric}: {metric: Metric}) {
  const rarity=metric.rarity;if(!rarity)return null;
  const supported=metric.status==='supported'&&rarity.status==='supported'&&rarity.percentile!==null;
  const percentile=rarity.percentile===null?null:Math.round(rarity.percentile);
  const suffix=percentile!==null&&percentile%100>=11&&percentile%100<=13?'th':({1:'st',2:'nd',3:'rd'} as Record<number,string>)[(percentile??0)%10]||'th';
  return <div className="rarity-record"><span className="eyebrow">HISTORICAL COMPARISON</span><strong>{supported?`${percentile}${suffix} percentile`:'Historical percentile unavailable'}</strong>{!supported&&<p>{human(rarity.reasonCode,'Reference coverage or model validation is insufficient.')}</p>}<p>{rarity.comparison}</p><p className="small muted">Reference: {rarity.referencePeriod} · {rarity.gameCount} games<br/>Model: {rarity.modelVersion}</p><code className="checksum">Reference SHA-256: {rarity.referenceChecksum}</code><p className="small muted">A measure of rarity in this comparison, not a probability of manipulation.</p></div>;
}
export function WpTimeline({points: raw, home, away}: {points: AnalysisResult["timeline"]; home: string; away: string}) {
  const probability = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const isOvertime = (play: AnalysisResult["timeline"][number]) => play.quarter !== null && play.quarter > 4;
  const available = (play: AnalysisResult["timeline"][number]) => probability(play.homeWp) && (!isOvertime(play) || play.status === "experimental" || play.status === "observed");
  const points = raw.map((play,index)=>({index,probability:play.homeWp,play})).filter((point): point is typeof point & {probability:number}=>available(point.play) && probability(point.probability));
  if (!raw.length) return <EmptyState title="Game momentum unavailable" compact>This report has no recorded game states for the chart.</EmptyState>;
  const x = (index:number) => 44 + index / Math.max(raw.length-1,1) * 892;
  const y = (probability:number) => 24 + (1-probability) * 180;
  const line = points.map((point,index)=>`${index===0 ? "M" : "L"}${x(point.index)},${y(point.probability)}`).join(" ");
  const isolated = points.length===1 && points[0].play.status!=="observed" ? points : [];
  const observed = points.filter(point=>point.play.status==="observed");
  const estimates = points.filter(point=>point.play.status!=="observed");
  const overtimeEstimates = estimates.filter(point=>isOvertime(point.play));
  const overtime:{start:number;end:number}[]=[];
  raw.forEach((play,index)=>{
    if(!isOvertime(play))return;
    const previous=overtime[overtime.length-1];
    if(previous && previous.end===index-1)previous.end=index;else overtime.push({start:index,end:index});
  });
  const missing=raw.length-points.length;
  const overtimeMissing=raw.filter(play=>isOvertime(play) && !available(play)).length;
  const overtimeLine=points.flatMap((point,index)=>{
    if(point.play.status!=="experimental" || !isOvertime(point.play))return [];
    const previous=points[index-1];
    return [previous ? `M${x(previous.index)},${y(previous.probability)} L${x(point.index)},${y(point.probability)}` : `M${x(point.index)},${y(point.probability)}`];
  }).join(" ");
  return <div className="wp-chart">
    <div className="chart-legend"><span><i />{teamName(home)} chance to win · vs. {teamName(away)}</span><span className="muted">Before-play estimates{overtimeEstimates.length>0 ? " · amber = experimental overtime" : ""}{observed.length>0 ? " · circle = recorded result" : ""}</span></div>
    {points.length ? <svg viewBox="0 0 960 245" role="img" aria-labelledby="wp-title wp-desc">
      <title id="wp-title">{`${teamName(home)} chance to win during the game`}</title><desc id="wp-desc">{estimates.length} preplay estimates across {raw.length} recorded game entries; {overtimeEstimates.length} use an experimental overtime model. {missing} entries have no estimate. The line connects available values; intermediate values are not calculated.{overtime.length>0 ? " The shaded region marks overtime." : ""}{observed.length>0 ? " A separate circle identifies the recorded final outcome, not a forecast." : " The line stops at the last available estimate."} All recorded entries appear in the table below.</desc>
      {overtime.map(range=>{const left=Math.max(44,x(range.start-.5)),right=Math.min(936,x(range.end+.5)),width=right-left;return <g className="chart-overtime-region" key={range.start}><rect x={left} y="24" width={width} height="180" fill="#dce2d3"/><line x1={left} x2={left} y1="24" y2="204" stroke="#788171" strokeDasharray="4 4"/>{width>=90 && <><text x={left+width/2} y="42" textAnchor="middle" fontSize="13" fill="#4d5c44">OVERTIME</text><text x={left+width/2} y="59" textAnchor="middle" fontSize="11" fill="#4d5c44">{overtimeEstimates.length ? "Experimental estimates" : "Limited data"}</text></>}</g>;})}
      {[0,.5,1].map(value=><g key={value}><line x1="44" x2="936" y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".12" strokeDasharray={value===.5 ? "4 5" : undefined}/><text x="0" y={y(value)+5} fill="currentColor" fontSize="11">{value*100}%</text></g>)}
      <path d={line} fill="none" stroke="var(--ink)" strokeWidth="2.6" vectorEffect="non-scaling-stroke"/>
      {overtimeLine && <path className="chart-overtime-estimates" d={overtimeLine} fill="none" stroke="#9b6511" strokeWidth="2.6" vectorEffect="non-scaling-stroke"/>}
      {isolated.map(point=><circle className="chart-isolated-estimate" key={point.index} cx={x(point.index)} cy={y(point.probability)} r="3" fill="var(--ink)"><title>{`Play ${raw[point.index].playId}: ${(point.probability*100).toFixed(1)}% before the play`}</title></circle>)}
      {observed.map(point=><circle className="chart-observed-result" key={point.index} cx={x(point.index)} cy={y(point.probability)} r="4.5" fill="var(--paper, #fffef9)" stroke="var(--ink)" strokeWidth="2"><title>{`Recorded final result: ${point.play.tieProbability===1 ? "tie" : point.probability===1 ? `${teamName(home)} won` : `${teamName(away)} won`}. This point is an observation, not a forecast.`}</title></circle>)}
      <text x="44" y="234" fill="currentColor" fontSize="11">First recorded entry</text><text x="936" y="234" textAnchor="end" fill="currentColor" fontSize="11">Last recorded entry</text>
    </svg> : <p className="chart-no-estimates">No estimates are available for this chart. You can still inspect every recorded entry below.</p>}
    <details className="chart-notes"><summary>About this chart</summary>
    <div className="chart-coverage"><p><strong>{estimates.length} model estimates</strong> across {raw.length} recorded game entries{observed.length>0 ? `, plus ${observed.length} recorded final result` : ""}.</p>{missing>0 && <p><strong>{missing} entries have no estimate</strong>{overtimeMissing>0 ? <>: {overtimeMissing} overtime entries{missing>overtimeMissing ? ` and ${missing-overtimeMissing} other recorded states` : ""}</> : null}.</p>}{overtime.length>0 && <><p className="chart-overtime-note"><span className="overtime-swatch" aria-hidden="true"/>Overtime is shaded. {overtimeEstimates.length>0 ? `${overtimeEstimates.length} experimental estimates use a separate overtime model.` : "No overtime forecast meets this model’s data requirements."}</p><p>The overtime model requires at least 20 comparable prior games with matching possession rules. Sparse or ambiguous states stay unrated. It estimates wins, losses and ties separately; <a href="/methodology#overtime-method">see coverage and limits</a>.</p></>}</div>
    <p className="chart-interpolation-note">Line connects available values; intermediate values are not calculated.</p>
    <p className="chart-preplay-note">The horizontal axis follows recorded entries, not elapsed game time. Forecasts describe the state before a play.{observed.length>0 ? " The final circle shows the recorded outcome. A tied game has 0% win and 100% tie at that point." : " The line ends at the last available forecast."}</p>
    </details>
    <details className="chart-table"><summary>View all chart data ({raw.length} entries)</summary><div className="table-scroll"><table><caption className="sr-only">{teamName(home)} chance to win and estimate source for every recorded game entry</caption><thead><tr><th scope="col">Period</th><th scope="col">Clock</th><th scope="col">Source play</th><th scope="col">{home} win chance</th>{overtime.length>0 && <th scope="col">Tie chance</th>}<th scope="col">Estimate source</th></tr></thead><tbody>{raw.map((play,index)=><tr className={available(play) ? "" : "chart-estimate-unavailable"} key={`${play.playId}:${index}`}><td>{play.quarter===null ? "—" : play.quarter>4 ? play.quarter===5 ? "OT" : `OT ${play.quarter-4}` : `Q${play.quarter}`}</td><td>{play.clock || "—"}</td><td><a href={`#play-${encodeURIComponent(play.playId)}`}>Play {play.playId} ↗</a></td><td>{available(play) ? `${(play.homeWp!*100).toFixed(1)}%` : "No estimate"}</td>{overtime.length>0 && <td>{available(play) && probability(play.tieProbability) ? `${(play.tieProbability*100).toFixed(1)}%` : "—"}</td>}<td>{play.status==="observed" ? "Recorded final outcome" : isOvertime(play) ? play.status==="experimental" && available(play) ? <>Experimental overtime<br/><span className="small">{play.supportGames} comparable prior games</span></> : human(play.reasonCode,"Overtime data insufficient") : available(play) ? "Regulation model" : "State outside model coverage"}</td></tr>)}</tbody></table></div></details>
  </div>;
}
