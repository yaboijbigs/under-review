import type { GameAudit, GameAuditFlag, GameProfile } from './contracts.js';

export type VerdictLevel = 'highly_unusual'|'unusual'|'key_plays'|'no_flag'|'limited'|'awaiting';
export interface GameVerdict {
 level:VerdictLevel;label:string;shortLabel:string;summary:string;reasons:string[];
 comparison:{wins:number;matchingGames:number;winRate:number|null;startSeason:number|null;endSeason:number|null}|null;
 reviewCount:number;evidenceNote:string;tone:'high'|'elevated'|'neutral'|'limited'|'waiting';
}

const names:Record<string,string>={ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',BAL:'Baltimore Ravens',BUF:'Buffalo Bills',CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',CLE:'Cleveland Browns',DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',LA:'Los Angeles Rams',LAR:'Los Angeles Rams',LAC:'Los Angeles Chargers',LV:'Las Vegas Raiders',MIA:'Miami Dolphins',MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SEA:'Seattle Seahawks',SF:'San Francisco 49ers',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders'};
export const teamName=(code:string):string=>names[code]??code;
const count=(n:number)=>new Intl.NumberFormat('en-US').format(n);
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const integer=(n:unknown):n is number=>finite(n)&&Number.isInteger(n)&&n>=0;
const complete=(p:GameProfile)=>[p.pointsFor,p.pointsAgainst,p.totalYards,p.opponentYards,p.penalties,p.penaltyYards,p.turnoverMargin].every(n=>finite(n)&&Number.isInteger(n))&&integer(p.pointsFor)&&integer(p.pointsAgainst)&&integer(p.penalties)&&integer(p.penaltyYards)&&p.team!==p.opponent;
const profileFacts=(p:GameProfile):string[]=>[
 finite(p.totalYards)?`${teamName(p.team)} gained ${count(p.totalYards)} yards on offense.`:null,
 finite(p.penaltyYards)&&finite(p.penalties)?`${count(p.penalties)} penalties cost them ${count(p.penaltyYards)} yards.`:null,
 finite(p.turnoverMargin)?p.turnoverMargin<0?`They lost the turnover battle by ${count(Math.abs(p.turnoverMargin))}.`:p.turnoverMargin>0?`They won the turnover battle by ${count(p.turnoverMargin)}.`:'The turnover battle was even.':null,
].filter((s):s is string=>s!==null);

function validCounts(flag:GameAuditFlag):boolean{
 const r=flag.reference;
 return [r.matchingGames,r.wins,r.losses,r.ties,r.teamGames].every(integer)&&r.matchingGames<=r.teamGames&&r.wins+r.losses+r.ties===r.matchingGames;
}
function hasReference(audit:GameAudit):boolean{
 const r=audit.reference;
 return /^[a-f0-9]{64}$/i.test(r.checksum??'')&&integer(r.teamGames)&&r.teamGames>0&&integer(r.startSeason)&&integer(r.endSeason)&&r.startSeason<=r.endSeason&&audit.profiles.every(p=>r.endSeason!<p.season);
}
const conditionLabels:Record<string,string>={
 'Total offense below 200 yards':'less than 200 yards of offense',
 'At least 100 penalty yards':'at least 100 penalty yards',
 'Negative turnover margin':'losing the turnover battle',
};
function validFlag(audit:GameAudit,flag:GameAuditFlag):boolean{
 const p=audit.profiles.find(p=>p.team===flag.team);const r=flag.reference;
 return !!p&&complete(p)&&p.pointsFor!>p.pointsAgainst!&&validCounts(flag)&&r.teamGames===audit.reference.teamGames&&r.startSeason===audit.reference.startSeason&&r.endSeason===audit.reference.endSeason
  &&flag.conditions.length>0&&new Set(flag.conditions).size===flag.conditions.length&&flag.conditions.every(c=>c==='Total offense below 200 yards'?p.totalYards!<200:c==='At least 100 penalty yards'?p.penaltyYards!>=100:c==='Negative turnover margin'?p.turnoverMargin!<0:false)
  &&(r.matchingGames<20?flag.status==='rare_sample'&&r.winRate===null:finite(r.winRate)&&Math.abs(r.winRate-r.wins/r.matchingGames)<1e-9&&(r.winRate<=.05?flag.status==='historical_outlier':r.winRate<=.1?flag.status==='unusual_profile':flag.status==='context'));
}
function supportedFlag(audit:GameAudit,flag:GameAuditFlag):boolean{
 const r=flag.reference;
 if(!hasReference(audit)||!validFlag(audit,flag)||r.matchingGames<20||!finite(r.winRate))return false;
 return (flag.status==='historical_outlier'&&r.winRate<=.05)||(flag.status==='unusual_profile'&&r.winRate>.05&&r.winRate<=.1);
}
const comparison=(flag:GameAuditFlag):GameVerdict['comparison']=>({wins:flag.reference.wins,matchingGames:flag.reference.matchingGames,winRate:flag.reference.matchingGames>=20?flag.reference.winRate:null,startSeason:flag.reference.startSeason,endSeason:flag.reference.endSeason});

/** Plain-language presentation of the existing fixed checks. No new score or fitted threshold. */
export function getGameVerdict(audit:GameAudit|null|undefined,hasAnalysis=true):GameVerdict{
 const base={comparison:null,reviewCount:audit?.reviewCandidates.length??0,evidenceNote:'Statistical rarity and flagged plays do not establish why a game happened.'};
 if(!hasAnalysis)return {...base,level:'awaiting',label:'Waiting for game data',shortLabel:'Awaiting data',summary:'The report will appear automatically after the game ends and its data passes validation.',reasons:[],tone:'waiting'};
 if(!audit)return {...base,level:'limited',label:'Game verdict not available yet',shortLabel:'Verdict pending',summary:'The statistical analysis is complete, but this saved report does not yet include the game-level comparison.',reasons:[],tone:'limited'};
 const invalidFlag=audit.flags.some(flag=>!validFlag(audit,flag));
 const supported=invalidFlag?[]:audit.flags.filter(flag=>supportedFlag(audit,flag));
 const strongest=supported.find(flag=>flag.status==='historical_outlier')??supported.find(flag=>flag.status==='unusual_profile');
 if(strongest){
  const p=audit.profiles.find(p=>p.team===strongest.team)!;
  const high=strongest.status==='historical_outlier';
  const r=strongest.reference;
  const conditions=strongest.conditions.map(condition=>conditionLabels[condition]);
  return {...base,level:high?'highly_unusual':'unusual',label:high?'Highly unusual win':'Unusual win',shortLabel:high?'Highly unusual':'Unusual',
   summary:`${teamName(p.team)} won despite ${conditions.join(' and ')}. Teams with that combination won ${count(r.wins)} of ${count(r.matchingGames)} matching games in the historical reference.`,
   reasons:profileFacts(p),comparison:comparison(strongest),tone:high?'high':'elevated',
   evidenceNote:`The comparison covers ${r.startSeason}–${r.endSeason}. It describes past results, not the odds that this game was rigged.`};
 }
 const profiles=audit.profiles;
 const compatible=profiles.length===2&&profiles.every(complete)&&profiles[0].team===profiles[1].opponent&&profiles[1].team===profiles[0].opponent&&profiles[0].gameId===profiles[1].gameId&&profiles[0].pointsFor===profiles[1].pointsAgainst&&profiles[1].pointsFor===profiles[0].pointsAgainst;
 const winner=profiles.find(p=>finite(p.pointsFor)&&finite(p.pointsAgainst)&&p.pointsFor>p.pointsAgainst);
 const sparse=audit.flags.find(flag=>flag.status==='rare_sample'&&validCounts(flag));
 if(!compatible||!hasReference(audit)||invalidFlag||sparse||!winner){
  const summary=!compatible?'Some team totals are missing or conflict with the final score, so we cannot reliably grade how unusual the result was.':!hasReference(audit)||invalidFlag?'The historical comparison is unavailable or inconsistent, so we cannot reliably grade this result.':!winner?'This game ended in a tie. The current historical checks grade winning profiles, so they do not rate this result.':`This combination has only ${count(sparse!.reference.matchingGames)} matching games in the historical reference—too few for a reliable unusual-win label.`;
  return {...base,level:'limited',label:'Not enough data for a verdict',shortLabel:'Limited data',summary,reasons:winner?profileFacts(winner):[],comparison:sparse&&hasReference(audit)&&!invalidFlag?comparison(sparse):null,tone:'limited',evidenceNote:base.reviewCount?`${base.reviewCount} ${base.reviewCount===1?'play was':'plays were'} still flagged for a closer look. Missing evidence is not a clean bill of health.`:'The available statistical analysis remains below; missing evidence is not a clean bill of health.'};
 }
 if(base.reviewCount)return {...base,level:'key_plays',label:'Key plays flagged',shortLabel:'Key plays flagged',summary:`No unusual winning pattern was found in the checks we ran. ${base.reviewCount} ${base.reviewCount===1?'play deserves':'plays deserve'} a closer look.`,reasons:profileFacts(winner),tone:'neutral',evidenceNote:'These plays were selected for review by the automated scan. A flag alone does not mean the call was wrong.'};
 return {...base,level:'no_flag',label:'No unusual result detected',shortLabel:'No major flag',summary:'The winning team did not trigger our unusual-win checks, and the play scan found no key review candidates.',reasons:profileFacts(winner),tone:'neutral',evidenceNote:'This is the result of the checks we can run on the available data, not a review of every officiating decision.'};
}
