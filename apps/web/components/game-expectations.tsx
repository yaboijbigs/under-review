import type { GameExpectations } from '@under-review/core/expectations-contracts';

const n=(value:number|null)=>value===null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value);
const margin=(value:number|null,home:string,away:string)=>value===null?'Unavailable':Math.abs(value)<.05?'Even':`${value>0?home:away} by ${n(Math.abs(value))}`;
const penalties=(count:number|null,yards:number|null)=>`${n(count)} / ${n(yards)} yd`;

export function ExpectedPerformance({expectations:e,outcomeOnly=false}:{expectations:GameExpectations|undefined;outcomeOnly?:boolean}){
 if(!e)return null;
 const teams=[e.awayTeam,e.homeTeam].map(team=>e.teams.find(t=>t.team===team)).filter(t=>t!==undefined);
 const outcome=e.outcome,ref=e.referee;
 return <div className="expectations-comparison">
  <section className="market-comparison" aria-labelledby="performance-title">
   <div className="market-heading"><h3 id="performance-title">Did the score fit the performance?</h3><span>Yardage + turnovers</span></div>
   <div className="market-numbers"><div><span>Expected from the box score</span><strong>{margin(outcome.expectedHomeMargin,e.homeTeam,e.awayTeam)}</strong></div><div><span>Actual final margin</span><strong>{margin(outcome.actualHomeMargin,e.homeTeam,e.awayTeam)}</strong></div><div><span>Difference</span><strong>{n(outcome.residual===null?null:Math.abs(outcome.residual))} <small>points</small></strong></div></div>
   <p>This compares the teams’ final yardage and turnover margin with past games. It is an after-game comparison, not a pregame prediction.</p>
   {outcome.status==='supported'&&<p className="market-rarity">{outcome.atLeastAsUnusual} of {outcome.calibrationGames} comparison games had a difference at least this large.</p>}
  </section>
  {!outcomeOnly&&<><section className="market-comparison" aria-labelledby="penalty-expectations-title">
   <div className="market-heading"><h3 id="penalty-expectations-title">Were the penalties unusual?</h3><span>Accepted penalties / yards</span></div>
   <div className="table-scroll"><table className="profile-table"><caption className="sr-only">Actual penalties compared with league, team, opponent and referee expectations</caption><thead><tr><th scope="col">Comparison</th>{teams.map(t=><th scope="col" key={t.team}>{t.team}</th>)}</tr></thead><tbody>
    <tr><th scope="row">Actual</th>{teams.map(t=><td key={t.team}><strong>{penalties(t.actual.penalties,t.actual.penaltyYards)}</strong></td>)}</tr>
    <tr><th scope="row">Expected for this matchup</th>{teams.map(t=><td key={t.team}>{penalties(t.expected?.penalties??null,t.expected?.penaltyYards??null)}</td>)}</tr>
    <tr><th scope="row">League average</th>{teams.map(t=><td key={t.team}>{penalties(t.league.meanPenalties,t.league.meanPenaltyYards)}</td>)}</tr>
    <tr><th scope="row">Team’s usual penalties</th>{teams.map(t=><td key={t.team}>{penalties(t.teamHistory.meanPenalties,t.teamHistory.meanPenaltyYards)}<small> · {t.teamHistory.games} games</small></td>)}</tr>
    <tr><th scope="row">Opponent usually draws</th>{teams.map(t=><td key={t.team}>{penalties(t.opponentDrawn.meanPenalties,t.opponentDrawn.meanPenaltyYards)}<small> · {t.opponentDrawn.games} games</small></td>)}</tr>
   </tbody></table></div>
   {e.penalty.status==='supported'&&<p className="market-rarity">The combined penalty total and imbalance were at least this unusual in {e.penalty.atLeastAsUnusual} of {e.penalty.calibrationGames} comparison games.</p>}
   <p className="small muted">Expectations blend team history, penalties drawn by the opponent and available referee history. Counts and yards are evaluated together.</p>
  </section>
  <section className="market-comparison referee-comparison" aria-labelledby="referee-title">
   <div className="market-heading"><h3 id="referee-title">The referee: {ref.status==='conflict'?'Assignment disputed':ref.name??'Not available'}</h3><span>Head official</span></div>
   {ref.games>0&&ref.status!=='conflict'&&ref.status!=='missing'?<>
    <p>In {ref.games} earlier games with this head referee, crews called an average of <strong>{n(ref.meanTotalPenalties)} accepted penalties for {n(ref.meanTotalPenaltyYards)} yards</strong> across both teams.</p>
    <div className="table-scroll"><table className="profile-table"><caption className="sr-only">Team history with this head referee</caption><thead><tr><th scope="col">Team history with this referee</th>{teams.map(t=><th scope="col" key={t.team}>{t.team}</th>)}</tr></thead><tbody>
     <tr><th scope="row">Games</th>{teams.map(t=><td key={t.team}>{t.refereeHistory.games}</td>)}</tr>
     <tr><th scope="row">Wins–losses–ties</th>{teams.map(t=><td key={t.team}>{t.refereeHistory.wins}–{t.refereeHistory.losses}–{t.refereeHistory.ties}</td>)}</tr>
     <tr><th scope="row">Team penalties per game</th>{teams.map(t=><td key={t.team}>{penalties(t.refereeHistory.meanPenalties,t.refereeHistory.meanPenaltyYards)}</td>)}</tr>
    </tbody></table></div>
    <details className="market-method"><summary>Referee comparison details</summary><p>Home teams: {penalties(ref.home.meanPenalties,ref.home.meanPenaltyYards)} per game. Away teams: {penalties(ref.away.meanPenalties,ref.away.meanPenaltyYards)} per game.</p><p>These are crew totals in games led by {ref.name}; they do not identify who threw each flag. Team win records are context and do not increase the rating. Small samples receive less weight.</p>{ref.status==='schedule_only'&&<p>The schedule supplies this assignment. A matching full-crew record was not available in the frozen officials release.</p>}</details>
   </>:<p>{ref.status==='conflict'?'The assignment sources disagree, so referee comparisons are excluded.':ref.name?`There is not enough earlier history for ${ref.name}.`:'No reliable head-referee assignment is available yet.'} Team and league comparisons remain available.</p>}
  </section>
  <details className="audit-method"><summary>Comparison coverage & method</summary><p>Baseline seasons: {e.cutoff.trainingSeasons.join(', ')||'Unavailable'}. Calibration seasons: {e.cutoff.calibrationSeasons.join(', ')||'Unavailable'}.</p><p>Each calibration game is evaluated using only seasons before that game. No result from {e.cutoff.targetSeason} enters this report’s historical baseline.</p>{e.notes.length>0&&<ul>{e.notes.map((note,i)=><li key={i}>{note}</li>)}</ul>}<p>Model: {e.version}</p><code className="checksum">Reference SHA-256: {e.reference.checksum}</code></details></>}
 </div>;
}
