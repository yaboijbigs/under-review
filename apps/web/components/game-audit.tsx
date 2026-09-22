import Link from "next/link";
import type { Game, GameAudit, GameAuditFlag, GameProfile, ReviewCandidate } from "@under-review/core/contracts";
import { getGameVerdict } from "@under-review/core/consumer-summary";
import { auditLabel, human, referencePeriod, teamName } from "@/lib/presentation";

export function GameVerdict({audit}: {audit: GameAudit | undefined}) {
  const verdict = getGameVerdict(audit);
  const comparison = verdict.comparison;
  return <section className={`game-verdict verdict-${verdict.tone}`} aria-labelledby="verdict-title" data-verdict={verdict.level}>
    <div className="verdict-main"><p className="eyebrow"><span className="verdict-indicator" aria-hidden="true"/>THE VERDICT</p><h2 id="verdict-title">{verdict.label}</h2><p className="verdict-summary">{verdict.summary}</p>{verdict.reasons.length>0 && <ul className="verdict-reasons">{verdict.reasons.slice(0,3).map((reason,index)=><li key={index}>{reason}</li>)}</ul>}</div>
    {comparison && comparison.matchingGames>0 && <aside className="verdict-comparison"><span className="eyebrow">THE HISTORICAL COMPARISON</span><strong>{comparison.wins}<span> / {comparison.matchingGames}</span></strong><p>similar past team performances ended in a win</p><span className="comparison-period">{referencePeriod(comparison.startSeason,comparison.endSeason)}</span><a href="#game-audit">See the comparison →</a></aside>}
    <div className="verdict-note"><span>{verdict.evidenceNote}</span><a href="/methodology#game-audit-method">How we decide ↗</a></div>
  </section>;
}

const count = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en-US", {maximumFractionDigits: 1}).format(value);
const profileRows: {key: keyof Pick<GameProfile, "pointsFor" | "totalYards" | "penalties" | "penaltyYards" | "turnoverMargin" | "nonOffensiveTouchdowns">; label: string; signed?: boolean}[] = [
  {key:"pointsFor",label:"Points scored"},
  {key:"totalYards",label:"Total offensive yards"},
  {key:"penalties",label:"Penalties"},
  {key:"penaltyYards",label:"Penalty yards"},
  {key:"turnoverMargin",label:"Turnover margin",signed:true},
  {key:"nonOffensiveTouchdowns",label:"Non-offensive touchdowns"},
];

function ProfileTable({profiles, game}: {profiles: GameProfile[]; game: Game}) {
  const ordered = [game.awayTeam, game.homeTeam].map(team => profiles.find(profile => profile.team === team));
  return <div className="audit-profile"><div className="audit-subheading"><span className="eyebrow">THE BOX SCORE THAT MATTERS</span><h3>How the teams performed</h3></div>
    <div className="table-scroll"><table className="profile-table"><caption className="sr-only">Actual team statistics for {game.awayTeam} at {game.homeTeam}</caption><thead><tr><th scope="col">Game statistic</th>{ordered.map((profile,index) => <th scope="col" key={index}><span>{index === 0 ? game.awayTeam : game.homeTeam}</span>{profile?.pointsFor !== null && profile?.pointsFor !== undefined && profile.pointsAgainst !== null && <small>{profile.pointsFor > profile.pointsAgainst ? "WIN" : profile.pointsFor < profile.pointsAgainst ? "LOSS" : "TIE"}</small>}</th>)}</tr></thead><tbody>{profileRows.map(row => <tr key={row.key}><th scope="row">{row.label}</th>{ordered.map((profile,index) => {const value=profile?.[row.key]??null;return <td key={index}>{row.signed && value !== null && value > 0 ? "+" : ""}{count(value)}</td>;})}</tr>)}</tbody></table></div>
  </div>;
}

function HistoricalFlag({flag}: {flag: GameAuditFlag}) {
  const ref=flag.reference;
  return <article className={`audit-flag audit-flag-${flag.status}`}>
    <div className="audit-flag-top"><span className="audit-team">{teamName(flag.team)}</span><span className="audit-flag-status">{auditLabel(flag.status)}</span></div>
    <h3>{flag.title}</h3><p>{flag.detail}</p>
    {flag.conditions.length>0 && <ul className="audit-conditions">{flag.conditions.map((condition,index)=><li key={index}>{condition}</li>)}</ul>}
    <div className="historical-count"><strong>{ref.matchingGames > 0 ? <>{count(ref.wins)} <span>/ {count(ref.matchingGames)}</span></> : "No prior matches"}</strong><span>{ref.matchingGames > 0 ? "prior matching team-games were wins" : "in the available historical sample"}</span></div>
    <p className="historical-coverage">{count(ref.losses)} losses · {count(ref.ties)} ties among the matches<br/>{count(ref.teamGames)} team-games checked · {referencePeriod(ref.startSeason,ref.endSeason)}</p>
  </article>;
}

export function GameAnomalyAudit({audit, game, fallbackSummary}: {audit: GameAudit | undefined; game: Game; fallbackSummary: string}) {
  const prominentFlags=audit ? [...audit.flags.filter(flag=>flag.status==='historical_outlier'),...audit.flags.filter(flag=>flag.status==='unusual_profile'),...audit.flags.filter(flag=>flag.conditions.length===3 && !['historical_outlier','unusual_profile'].includes(flag.status))] : [];
  if(audit && !prominentFlags.length){const sparse=audit.flags.find(flag=>flag.status==='rare_sample');if(sparse)prominentFlags.push(sparse);}
  const additionalFlags=audit?.flags.filter(flag=>!prominentFlags.some(shown=>shown.id===flag.id))??[];
  return <section id="game-audit" className={`game-audit ${audit ? `audit-${audit.status}` : "audit-not-computed"}`} aria-labelledby="game-audit-title">
    <div className="audit-heading"><div><p className="eyebrow">THE RESULT IN CONTEXT</p><h2 id="game-audit-title">Why this result stands out—or doesn’t</h2></div></div>
    {audit ? <>
      <ProfileTable profiles={audit.profiles} game={game}/>
      {audit.context.length > 0 && <div className="audit-context"><div className="audit-subheading"><span className="eyebrow">THE BREAKS BEHIND THE SCORE</span><h3>How the result took shape</h3></div><div className="audit-context-grid">{audit.context.map((item,index)=><article key={index}><span className="eyebrow">{item.team ? `${teamName(item.team)} · ` : ""}{human(item.kind)}</span><p>{item.text}</p>{item.playIds.length > 0 && <div className="event-links">{item.playIds.map(id=><a key={id} href={`#play-${encodeURIComponent(id)}`}>See play {id} ↗</a>)}</div>}</article>)}</div></div>}
      {(prominentFlags.length > 0 || additionalFlags.length > 0) && <details className="additional-profile-comparisons"><summary>Explore the historical comparisons ({prominentFlags.length+additionalFlags.length})</summary><p className="small muted">These patterns overlap. They are separate comparisons, not independent evidence of multiple problems.</p><div className="audit-flags">{[...prominentFlags,...additionalFlags].map(flag=><HistoricalFlag key={flag.id} flag={flag}/>)}</div></details>}
      <details className="audit-method"><summary>Historical coverage & audit method</summary><p>{count(audit.reference.teamGames)} prior team-games · {referencePeriod(audit.reference.startSeason,audit.reference.endSeason)}</p><p>Audit: {audit.version}<br/>Reference: {audit.reference.version}</p>{audit.reference.checksum && <code className="checksum">Reference SHA-256: {audit.reference.checksum}</code>}{audit.notes.length > 0 && <ul>{audit.notes.map((note,index)=><li key={index}>{note}</li>)}</ul>}</details>
    </> : <div className="audit-missing"><h3>Historical comparison not available</h3><p>This saved report does not include the game-level comparison. That is a data gap, not a finding that the game was ordinary.</p>{fallbackSummary && <details><summary>Earlier analysis summary</summary><p>{fallbackSummary}</p></details>}</div>}
    <div className="audit-footer"><span>{audit ? "Historical comparisons · exact counts" : "Historical comparisons not yet computed"}</span><Link href="/methodology#game-audit-method">How the historical comparison works ↗</Link></div>
  </section>;
}

function Candidate({candidate}: {candidate: ReviewCandidate}) {
  return <article className="review-candidate" id={`candidate-${candidate.id}`} data-play-id={candidate.playId}>
    <div className="candidate-top"><span className="candidate-clock">{candidate.quarter ? `Q${candidate.quarter}` : "Period unavailable"} · {candidate.clock || "Clock unavailable"}</span><span className="candidate-priority">{candidate.priority === "high" ? "High review priority" : "Review candidate"}</span></div>
    <h3>{candidate.team ? teamName(candidate.team) : "Game-changing moment"}<span className="muted"> · Play {candidate.playId}</span></h3><p className="candidate-description">{candidate.description}</p>
    <ul className="candidate-reasons">{candidate.reasons.map((reason,index)=><li key={index}>{human(reason)}</li>)}</ul>
    {candidate.observedWpSwing !== null && <p className="candidate-movement">Estimated chance to win moved {(Math.abs(candidate.observedWpSwing)*100).toFixed(1)} percentage points across this play.</p>}
    <div className="candidate-links"><a href={`#play-${encodeURIComponent(candidate.playId)}`}>Read the full play <span aria-hidden="true">↗</span></a>{candidate.existingEventId && <a href={`#event-${encodeURIComponent(candidate.existingEventId)}`}>Inspect the calculation ↗</a>}</div>
  </article>;
}

export function NeedsReview({audit}: {audit: GameAudit | undefined}) {
  const candidates=audit?.reviewCandidates;
  return <section id="needs-review" className={`needs-review ${candidates?.length ? "has-key-plays" : "no-key-plays"}`} aria-labelledby="needs-review-title"><div className="audit-heading"><div><p className="eyebrow">PLAYS FOR A CLOSER LOOK</p><h2 id="needs-review-title">Key plays to inspect {candidates && <span className="count">{candidates.length}</span>}</h2></div></div>
    {!candidates ? <p className="review-empty">This saved report does not include the automatic key-play scan.</p> : candidates.length ? <><p className="review-intro">These plays were flagged automatically because of the reasons below. They deserve a closer look; the flag itself is not a finding that a call was wrong.</p><div className="review-candidates">{candidates.slice(0,4).map(candidate=><Candidate key={candidate.id} candidate={candidate}/>)}</div>{candidates.length>4 && <details className="more-candidates"><summary>Show {candidates.length-4} more flagged {candidates.length-4 === 1 ? "play" : "plays"}</summary><div className="review-candidates">{candidates.slice(4).map(candidate=><Candidate key={candidate.id} candidate={candidate}/>)}</div></details>}</> : <p className="review-empty">The automatic scan found no plays meeting its review criteria. It does not assess the correctness of every call.</p>}
  </section>;
}
