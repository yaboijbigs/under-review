import { listGames } from "@under-review/core/repository";
import { EmptyState, GameCard, Unavailable } from "@/components/ui";
import { getGameVerdict, SUSPICION_SCALE } from "@under-review/core/consumer-summary";
import { teams, teamName, defaultNflSeason } from "@/lib/presentation";
export const dynamic = "force-dynamic";
export default async function Home({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const query = await searchParams; const currentSeason = defaultNflSeason(); const seasonValue = Number(query.season); const season = Number.isInteger(seasonValue) && seasonValue >= 1999 && seasonValue <= 2100 ? seasonValue : currentSeason;
  const weekValue = Number(query.week); const week = Number.isInteger(weekValue) && weekValue >= 1 && weekValue <= 22 ? weekValue : undefined;
  const requestedTeam = query.team === "LAR" ? "LA" : query.team;
  const team = typeof requestedTeam === "string" && teams.includes(requestedTeam) ? requestedTeam : undefined;
  const result = typeof query.result === "string" && [...SUSPICION_SCALE.map(tier=>tier.level),"limited"].includes(query.result) ? query.result : "";
  let games: Awaited<ReturnType<typeof listGames>> = []; let unavailable = false;
  try { games = await listGames({season, week, team, publishedOnly:true}); } catch { unavailable = true; }
  const totalReports = games.length;
  const elevatedCount = games.filter(game => (getGameVerdict(game.gameAudit).rating ?? 0)>=3).length;
  if(result) games = games.filter(game => getGameVerdict(game.gameAudit).level === result);
  const seasons = Array.from(new Set([season,...Array.from({length:Math.max(1,currentSeason-1998)},(_,i)=>currentSeason-i)])).sort((a,b)=>b-a);
  return <>
    <section className="home-intro"><div><p className="eyebrow"><span className="accent-line"/>NFL / {season} SEASON</p><h1>Was that game<br/><span>unusual?</span></h1><p>The score. The penalties. The referee’s history.</p></div><div className="intro-aside"><span className="issue-number">AUTOMATIC POSTGAME REPORTS</span><p>Go beyond the score.<br/><strong>Get a clear verdict.</strong></p></div></section>
    <section className="archive-section" aria-labelledby="archive-title">
      <div className="section-heading"><div><p className="eyebrow">THE GAMES, EXPLAINED</p><h2 id="archive-title">Game reports <span className="count">{games.length}</span></h2></div></div>
      <form className="filters" action="/">
        <label>Season<select name="season" defaultValue={season}>{seasons.map(year=><option key={year} value={year}>{year}</option>)}</select></label>
        <label>Week<select name="week" defaultValue={week || ""}><option value="">All weeks</option>{Array.from({length:22},(_,i)=>i+1).map(value=><option key={value} value={value}>{value <= 18 ? `Week ${value}` : `Postseason week ${value-18}`}</option>)}</select></label>
        <label>Team<select name="team" defaultValue={team || ""}><option value="">All teams</option>{teams.map(value=><option key={value} value={value}>{teamName(value)}</option>)}</select></label>
        <label>Rating<select name="result" defaultValue={result}><option value="">All ratings</option>{[...SUSPICION_SCALE].reverse().map(tier=><option key={tier.level} value={tier.level}>{tier.label} · {tier.rating}/5</option>)}<option value="limited">Unrated · Not enough data</option></select></label>
        <button className="button dark" type="submit">Apply filters <span aria-hidden="true">→</span></button><a className="clear-filter" href="/">Reset</a>
      </form>
      {!unavailable && totalReports > 0 && <p className="archive-context">Showing {games.length} of {totalReports} analyzed {totalReports === 1 ? "game" : "games"}{week ? ` in Week ${week}` : " across all weeks"}{team ? ` for the ${teamName(team)}` : ""}. <strong>{elevatedCount} rated Hmm or higher.</strong> <a href="/methodology#verdicts">What the scale means ↗</a></p>}
      {unavailable ? <Unavailable/> : games.length ? <div className="game-grid">{games.map(game=><GameCard key={game.id} game={game}/>)}</div> : <EmptyState title={result || team || week ? "No reports match these filters" : "Reports will appear here automatically"}>{result || team || week ? <>Try another filter, or <a href={`/?season=${season}&week=`}>show all reports for {season}</a>.</> : <>Reports appear when final game data is ready.</>}</EmptyState>}
    </section>
    <section className="editorial-strip" aria-label="How to read a report"><div><span className="strip-number">01</span><h3>Expected vs. actual</h3><p>Compare the final score with the spread and what the teams’ performance usually produces.</p></div><div><span className="strip-number">02</span><h3>Penalties in context</h3><p>See team averages, opponent tendencies and referee history alongside what happened.</p></div><div><span className="strip-number">03</span><h3>Do you agree?</h3><p>Give the rating a thumbs-up or thumbs-down, suggest your own score and join the discussion.</p></div></section>
  </>;
}
