import type {OfficiatingAudit} from '@under-review/core/officiating-contracts';

const n=(v:number|null)=>v===null?'—':v.toFixed(1);
const familyNames:Record<string,string>={offensive_hold:'Offensive holding',defensive_pass:'Pass coverage',offensive_presnap:'Offensive presnap',defensive_presnap:'Defensive presnap',personal_foul:'Personal fouls',other_offense:'Other offensive fouls',other_defense:'Other defensive fouls'};
export function OfficiatingComparison({audit:a}:{audit:OfficiatingAudit|undefined}){
 if(!a)return null;
 const r=a.result,teams=[a.awayTeam,a.homeTeam],strongest=r?.strongest==='drive'?r.drives.find(d=>d.driveId===r.strongestDrive):r?.game;
 return <section className="expectations-comparison" aria-labelledby="officiating-title">
  <div className="audit-subheading"><h3 id="officiating-title">Penalty impact</h3></div>
  {r&&strongest?<>
   <div className="market-numbers"><div><span>Largest pattern</span><strong>{r.strongest==='drive'?'One drive':'Whole game'}</strong></div><div><span>Estimated net benefit</span><strong>{n(Math.abs(strongest.actualHomeEp))} <small>expected points</small></strong></div><div><span>Favored</span><strong>{strongest.favoredTeam??'Neither team'}</strong></div></div>
   <p>We compare the field position, down and distance after enforcement with the supported alternative. This measures a ruling’s impact, not whether it was correct.</p>
   <details className="market-method"><summary>Calls behind the comparison ({r.events.length})</summary>
    <p>{r.coverage.valuedPenalties} of {r.coverage.acceptedPenalties} accepted regulation penalties could be valued. Other calls and missed calls are outside this estimate.</p>
    <div className="table-scroll"><table className="profile-table"><thead><tr><th>Call</th><th>Favored</th><th>Estimated points</th><th>Alternative</th></tr></thead><tbody>{[...r.events].sort((x,y)=>Math.abs(y.homeEp)-Math.abs(x.homeEp)).map(e=><tr key={e.playId}><th><a href={`#play-${encodeURIComponent(e.playId)}`}>{e.type} · {e.playId}</a></th><td>{e.team}</td><td>{n(Math.abs(e.homeEp))}</td><td>{e.assumption}</td></tr>)}</tbody></table></div>
   </details>
   <details className="market-method"><summary>Penalties versus expected</summary>
    <div className="table-scroll"><table className="profile-table"><caption>Modeled called penalties: actual / expected</caption><thead><tr><th>Penalty family</th>{teams.map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{Object.entries(familyNames).map(([family,label])=><tr key={family}><th>{label}</th>{teams.map(team=>{const row=r.rates.find(p=>p.team===team&&p.family===family);return <td key={team}>{row?`${row.actual} / ${n(row.expected)}`:'—'}</td>;})}</tr>)}</tbody></table></div>
    <p>Expectations account for play opportunities, game situation, team and opponent history. These counts cover modeled plays and can differ from the box score.</p>
   </details>
   {r.turningPoints.length>0&&<details className="market-method"><summary>Biggest momentum shifts</summary><ul>{r.turningPoints.map(p=><li key={p.playId}><a href={`#play-${encodeURIComponent(p.playId)}`}>Play {p.playId}</a>: {(100*Math.abs(p.homeWpChange)).toFixed(1)} percentage points toward {p.homeWpChange>0?a.homeTeam:a.awayTeam}{p.penalty?' · penalty recorded':''}.</li>)}</ul><p>These locate turning points. The change includes everything on the play and does not add to the rating.</p></details>}
  </>:<p>There is not enough supported play data to estimate penalty impact.</p>}
  <section className="market-comparison referee-comparison" aria-labelledby="crew-title"><div className="market-heading"><h3 id="crew-title">Officiating crew</h3><span>{a.crew.status==='complete'?'Full assignment':a.crew.status==='conflict'?'Conflicting assignments':a.crew.status==='partial'?'Partial assignment':'Not available'}</span></div>
   {a.crew.roles.length>0?<><div className="table-scroll"><table className="profile-table"><thead><tr><th>Role</th><th>Official</th></tr></thead><tbody>{a.crew.roles.map(o=><tr key={`${o.role}:${o.name}`}><th>{o.role}</th><td>{o.name}</td></tr>)}</tbody></table></div>
    <details className="market-method"><summary>Crew history</summary><div className="table-scroll"><table className="profile-table"><thead><tr><th>Official</th><th>Earlier games</th><th>Calls / game</th><th>Expected</th><th>Home-side difference</th></tr></thead><tbody>{a.crew.roles.map(o=><tr key={`${o.role}:${o.name}`}><th>{o.name}</th><td>{o.games}</td><td>{n(o.actualCallsPerGame)}</td><td>{n(o.expectedCallsPerGame)}</td><td>{n(o.homeBenefitResidualPerGame)}</td></tr>)}</tbody></table></div><p>These are game totals with each official assigned, not flags attributed to that person. A positive home-side difference means the call balance favored the home team relative to expectations. Crew histories did not improve predictions consistently, so they do not change the rating.</p></details>
   </>:<p>The source has not supplied a verified full crew for this game.</p>}
  </section>
 </section>;
}
