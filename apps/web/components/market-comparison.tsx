import type { MarketAudit } from '@under-review/core/contracts';
import { referencePeriod, teamName } from '@/lib/presentation';

const number=(value:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value);
function marginText(value:number,home:string,away:string){
  return value===0?'Even matchup':`${teamName(value>0?home:away)} by ${number(Math.abs(value))}`;
}
export function MarketComparison({market}:{market:MarketAudit|undefined}){
  if(!market)return null;
  if(market.status!=='available'||market.expectedHomeMargin===null||market.actualHomeMargin===null||market.absoluteError===null){
    return <section className="market-comparison market-unavailable" aria-labelledby="market-title"><h3 id="market-title">Spread vs. result</h3><p>A verified pregame line isn’t available for this report.</p></section>;
  }
  const label=market.surprise==='very_unusual'?'Way off expectations':market.surprise==='unusual'?'An unexpected result':market.surprise==='ordinary'?'Within the usual range':'Historical comparison unavailable';
  const ref=market.reference;
  const actual=market.actualHomeMargin===0?'Tie':marginText(market.actualHomeMargin,market.homeTeam,market.awayTeam);
  const ats=market.atsResult==='push'?'Push — the final margin matched the spread.':market.atsWinner?`${teamName(market.atsWinner)} covered the spread.`:null;
  return <section className={`market-comparison market-${market.surprise}`} aria-labelledby="market-title">
    <div className="market-heading"><h3 id="market-title">Spread vs. result</h3><span>{label}</span></div>
    <div className="market-numbers"><div><span>Expected margin</span><strong>{marginText(market.expectedHomeMargin,market.homeTeam,market.awayTeam)}</strong></div><div><span>Final margin</span><strong>{actual}</strong></div><div><span>Difference</span><strong>{number(market.absoluteError)} <small>points</small></strong></div></div>
    {ats&&<p className="market-ats">{ats}{market.underdogWon?' The underdog won outright.':''}</p>}
    {ref.games>0&&ref.tailRate!==null&&ref.atLeastAsSurprising!==null&&<p className="market-rarity">{number(ref.atLeastAsSurprising)} of {number(ref.games)} earlier games were at least this far from the spread ({number(ref.tailRate*100)}%).</p>}
    <details className="market-method"><summary>Where this comparison comes from</summary><p>The recorded closing spread is an expected winning margin, not the final score. We compare the size of the miss with earlier seasons: {referencePeriod(ref.startSeason,ref.endSeason)}. At least 500 prior games are required to affect the rating.</p><p>A result in the most unusual 10% can raise a game to Debatable; the most unusual 5% can raise it to Hmm. Spread alone cannot produce Sus or RIGGED?.</p>{market.source&&<a href={market.source.url} target="_blank" rel="noreferrer">View the source data ↗</a>}{market.notes.length>0&&<ul>{market.notes.map((note,index)=><li key={index}>{note}</li>)}</ul>}</details>
  </section>;
}
