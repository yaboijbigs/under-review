import { listGames } from "@under-review/core/repository";
import { EmptyState, GameCard, Unavailable } from "@/components/ui";
import { getGameVerdict } from "@under-review/core/consumer-summary";
import { teams, teamName, defaultNflSeason } from "@/lib/presentation";
export const dynamic = "force-dynamic";
export default async function Home({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const query = await searchParams; const currentSeason = defaultNflSeason(); const seasonValue = Number(query.season); const season = Number.isInteger(seasonValue) && seasonValue >= 1999 && seasonValue <= 2100 ? seasonValue : currentSeason;
  const weekValue = Number(query.week); const week = Number.isInteger(weekValue) && weekValue >= 1 && weekValue <= 22 ? weekValue : undefined;
  const requestedTeam = query.team === "LAR" ? "LA" : query.team;
  const team = typeof requestedTeam === "string" && teams.includes(requestedTeam) ? requestedTeam : undefined;
  const result = typeof query.result === "string" && ["unusual","key_plays","no_flag","limited"].includes(query.result) ? query.result : "";
  let games: Awaited<ReturnType<typeof listGames>> = []; let unavailable = false;
  try { games = await listGames({season, week, team, publishedOnly:true}); } catch { unavailable = true; }
  const totalReports = games.length;
  const unusualCount = games.filter(game => ["highly_unusual","unusual"].includes(getGameVerdict(game.gameAudit).level)).length;
  if(result) games = games.filter(game => {const level = getGameVerdict(game.gameAudit).level; return result === "unusual" ? ["highly_unusual","unusual"].includes(level) : level === result;});
  const seasons = Array.from(new Set([season,...Array.from({length:Math.max(1,currentSeason-1998)},(_,i)=>currentSeason-i)])).sort((a,b)=>b-a);
  return <>
    <section className="home-intro"><div><p className="eyebrow"><span className="accent-line"/>NFL / {season} SEASON</p><h1>Was that win<br/><span>unusual?</span></h1><p>Spot the outlier wins. Understand the breaks.<br/>See exactly which plays deserve a closer look.</p></div><div className="intro-aside"><span className="issue-number">AUTOMATIC POSTGAME REPORTS</span><p>Go beyond the score.<br/><strong>Get a clear verdict.</strong></p><span>Reports appear after final game data arrives and update as the data improves.</span></div></section>
    <section className="archive-section" aria-labelledby="archive-title">
      <div className="section-heading"><div><p className="eyebrow">THE GAMES, EXPLAINED</p><h2 id="archive-title">Game reports <span className="count">{games.length}</span></h2></div><span className="section-caption">Unusual results and key plays are flagged separately.</span></div>
      <form className="filters" action="/">
        <label>Season<select name="season" defaultValue={season}>{seasons.map(year=><option key={year} value={year}>{year}</option>)}</select></label>
        <label>Week<select name="week" defaultValue={week || ""}><option value="">All weeks</option>{Array.from({length:22},(_,i)=>i+1).map(value=><option key={value} value={value}>{value <= 18 ? `Week ${value}` : `Postseason week ${value-18}`}</option>)}</select></label>
        <label>Team<select name="team" defaultValue={team || ""}><option value="">All teams</option>{teams.map(value=><option key={value} value={value}>{teamName(value)}</option>)}</select></label>
        <label>Result<select name="result" defaultValue={result}><option value="">All results</option><option value="unusual">Unusual wins</option><option value="key_plays">Key plays to inspect</option><option value="no_flag">No unusual result detected</option><option value="limited">Not enough data</option></select></label>
        <button className="button dark" type="submit">Apply filters <span aria-hidden="true">→</span></button><a className="clear-filter" href="/">Reset</a>
      </form>
      {!unavailable && totalReports > 0 && <p className="archive-context">Showing {games.length} of {totalReports} analyzed {totalReports === 1 ? "game" : "games"}{week ? ` in Week ${week}` : " across all weeks"}{team ? ` for the ${teamName(team)}` : ""}. <strong>{unusualCount} {unusualCount === 1 ? "unusual win" : "unusual wins"}.</strong></p>}
      {unavailable ? <Unavailable/> : games.length ? <div className="game-grid">{games.map(game=><GameCard key={game.id} game={game}/>)}</div> : <EmptyState title={result || team || week ? "No reports match these filters" : "Reports will appear here automatically"}>{result || team || week ? <>Try another team or result, or <a href={`/?season=${season}&week=`}>show all reports for {season}</a>.</> : <>The first report appears once a completed game’s data is ready. New games are picked up automatically.</>}</EmptyState>}
    </section>
    <section className="editorial-strip" aria-label="How to read a report"><div><span className="strip-number">01</span><h3>Was the win unusual?</h3><p>We check winning teams against past performances with low yardage, heavy penalties, or a turnover deficit.</p></div><div><span className="strip-number">02</span><h3>Which plays stood out?</h3><p>Late flags, overturned scores, and other pivotal moments link directly to the play record.</p></div><div><span className="strip-number">03</span><h3>What does it prove?</h3><p>A flag means something deserves a closer look. A finding of a bad call needs evidence; a claim of rigging needs more.</p></div></section>
  </>;
}
