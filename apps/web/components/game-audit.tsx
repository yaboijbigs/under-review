import Link from "next/link";
import type { Game, GameAudit, GameAuditFlag, GameProfile, ReviewCandidate } from "@under-review/core/contracts";
import { auditLabel, human, referencePeriod } from "@/lib/presentation";

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
  return <div className="audit-profile"><div className="audit-subheading"><span className="eyebrow">ACTUAL GAME TOTALS</span><h3>The team profiles</h3></div>
    <div className="table-scroll"><table className="profile-table"><caption className="sr-only">Actual team statistics for {game.awayTeam} at {game.homeTeam}</caption><thead><tr><th scope="col">Game statistic</th>{ordered.map((profile,index) => <th scope="col" key={index}><span>{index === 0 ? game.awayTeam : game.homeTeam}</span>{profile?.pointsFor !== null && profile?.pointsFor !== undefined && profile.pointsAgainst !== null && <small>{profile.pointsFor > profile.pointsAgainst ? "WIN" : profile.pointsFor < profile.pointsAgainst ? "LOSS" : "TIE"}</small>}</th>)}</tr></thead><tbody>{profileRows.map(row => <tr key={row.key}><th scope="row">{row.label}</th>{ordered.map((profile,index) => {const value=profile?.[row.key]??null;return <td key={index}>{row.signed && value !== null && value > 0 ? "+" : ""}{count(value)}</td>;})}</tr>)}</tbody></table></div>
  </div>;
}

function HistoricalFlag({flag}: {flag: GameAuditFlag}) {
  const ref=flag.reference;
  return <article className={`audit-flag audit-flag-${flag.status}`}>
    <div className="audit-flag-top"><span className="audit-team">{flag.team}</span><span className="audit-flag-status">{auditLabel(flag.status)}</span></div>
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
    <div className="audit-heading"><div><p className="eyebrow">THE RESULT IN CONTEXT</p><h2 id="game-audit-title">Game anomaly audit</h2></div><span className="audit-status">{audit ? auditLabel(audit.status) : "Not yet computed"}</span></div>
    {audit ? <>
      <p className="audit-headline">{audit.headline}</p>
      {audit.reviewCandidates.length > 0 && <a className="audit-review-link" href="#needs-review"><span><strong>{audit.reviewCandidates.length}</strong> source {audit.reviewCandidates.length === 1 ? "play selected" : "plays selected"} for review</span><span>See the reasons →</span></a>}
      {prominentFlags.length > 0 && <div className="audit-flags">{prominentFlags.map(flag=><HistoricalFlag key={flag.id} flag={flag}/>)}</div>}
      {additionalFlags.length > 0 && <details className="additional-profile-comparisons"><summary>More profile comparisons ({additionalFlags.length})</summary><div className="audit-flags">{additionalFlags.map(flag=><HistoricalFlag key={flag.id} flag={flag}/>)}</div></details>}
      <ProfileTable profiles={audit.profiles} game={game}/>
      {audit.context.length > 0 && <div className="audit-context"><div className="audit-subheading"><span className="eyebrow">OBSERVED MECHANISMS</span><h3>How the result took shape</h3></div><div className="audit-context-grid">{audit.context.map((item,index)=><article key={index}><span className="eyebrow">{item.team ? `${item.team} · ` : ""}{human(item.kind)}</span><p>{item.text}</p>{item.playIds.length > 0 && <div className="event-links">{item.playIds.map(id=><a key={id} href={`#play-${encodeURIComponent(id)}`}>Source play {id} ↗</a>)}</div>}</article>)}</div></div>}
      <details className="audit-method"><summary>Historical coverage & audit method</summary><p>{count(audit.reference.teamGames)} prior team-games · {referencePeriod(audit.reference.startSeason,audit.reference.endSeason)}</p><p>Audit: {audit.version}<br/>Reference: {audit.reference.version}</p>{audit.reference.checksum && <code className="checksum">Reference SHA-256: {audit.reference.checksum}</code>}{audit.notes.length > 0 && <ul>{audit.notes.map((note,index)=><li key={index}>{note}</li>)}</ul>}</details>
    </> : <div className="audit-missing"><h3>Game profile audit not yet computed</h3><p>This saved revision predates the game-level profile audit. Its existing findings remain available below.</p>{fallbackSummary && <details><summary>Existing metric summary</summary><p>{fallbackSummary}</p></details>}</div>}
    <div className="audit-footer"><span>{audit ? "Historical comparisons · exact counts" : "Historical comparisons not yet computed"}</span><Link href="/methodology#game-audit-method">How the historical comparison works ↗</Link></div>
  </section>;
}

function Candidate({candidate}: {candidate: ReviewCandidate}) {
  return <article className="review-candidate" id={`candidate-${candidate.id}`} data-play-id={candidate.playId}>
    <div className="candidate-top"><span className="candidate-clock">{candidate.quarter ? `Q${candidate.quarter}` : "Period unavailable"} · {candidate.clock || "Clock unavailable"}</span><span className="candidate-priority">{candidate.priority === "high" ? "High review priority" : "Review candidate"}</span></div>
    <h3>Play {candidate.playId}{candidate.team ? <span className="muted"> · {candidate.team} offense</span> : null}</h3><p className="candidate-description">{candidate.description}</p>
    <ul className="candidate-reasons">{candidate.reasons.map((reason,index)=><li key={index}>{human(reason)}</li>)}</ul>
    {candidate.observedWpSwing !== null && <p className="candidate-movement">Observed WP movement: {(Math.abs(candidate.observedWpSwing)*100).toFixed(1)} percentage points. This includes the entire play.</p>}
    <div className="candidate-links"><a href={`#play-${encodeURIComponent(candidate.playId)}`}>Open full source play <span aria-hidden="true">↗</span></a>{candidate.existingEventId && <a href={`#event-${encodeURIComponent(candidate.existingEventId)}`}>Modeled event evidence ↗</a>}</div>
  </article>;
}

export function NeedsReview({audit}: {audit: GameAudit | undefined}) {
  const candidates=audit?.reviewCandidates;
  return <section id="needs-review" className="needs-review" aria-labelledby="needs-review-title"><div className="audit-heading"><div><p className="eyebrow">PLAYS FOR A CLOSER LOOK</p><h2 id="needs-review-title">Needs review {candidates && <span className="count">{candidates.length}</span>}</h2></div><span className="review-scope-label">Candidate selection · not a correctness ruling</span></div>
    {!candidates ? <p className="review-empty">The review-candidate scan has not been computed for this revision.</p> : candidates.length ? <><p className="review-intro">These source plays meet review criteria even when a modeled ruling impact is unavailable. The reasons below explain why each was selected; evidence review must establish what happened and who, if anyone, benefited from an incorrect ruling.</p><div className="review-candidates">{candidates.map(candidate=><Candidate key={candidate.id} candidate={candidate}/>)}</div></> : <p className="review-empty">No candidates were selected by this scan. That does not establish that every ruling was correct.</p>}
  </section>;
}
