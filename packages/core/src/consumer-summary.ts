import type { GameAudit, GameAuditFlag, GameProfile } from './contracts.js';

export const SUSPICION_RULES_VERSION = 'game-suspicion-v2';
export const SUSPICION_SCALE = [
 {level:'fair',rating:1,label:'Fair',definition:'No flags within the checks we can run.'},
 {level:'debatable',rating:2,label:'Debatable',definition:'Individual plays deserve a closer look, or the result was unusually far from the recorded spread.'},
 {level:'hmm',rating:3,label:'Hmm',definition:'An unusual win pattern, repeated penalty sequence, or very unusual result versus the spread.'},
 {level:'sus',rating:4,label:'Sus',definition:'A strong statistical flag or three-plus drive-extending penalties.'},
 {level:'extreme',rating:5,label:'RIGGED?',definition:'A strong statistical flag and a three-plus penalty sequence favored the winner.'},
] as const;
export type VerdictLevel = typeof SUSPICION_SCALE[number]['level']|'limited'|'awaiting';
export interface GameVerdict {
 level:VerdictLevel;label:string;shortLabel:string;summary:string;reasons:string[];
 rating:1|2|3|4|5|null;definition:string;rulesVersion:typeof SUSPICION_RULES_VERSION;
 cluster:{team:string;playIds:string[]}|null;
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

function driveClusters(audit:GameAudit):NonNullable<GameVerdict['cluster']>[] {
 const clusters:NonNullable<GameVerdict['cluster']>[]=[];
 for(const context of audit.context){
  if(context.kind!=='drive_extending_penalties'||!context.team||!names[context.team])continue;
  const profile=audit.profiles.find(p=>p.team===context.team);
  const playIds=[...new Set(context.playIds)];
  if(!profile||playIds.length<2||playIds.some(id=>!id.trim()))continue;
  let drive:string|undefined;
  const valid=playIds.every(playId=>{
   const candidates=audit.reviewCandidates.filter(candidate=>candidate.playId===playId);
   if(!candidates.length)return false;
   return candidates.every(candidate=>{
    if(candidate.team!==context.team||!candidate.reasons.some(reason=>reason===`Defensive penalty on ${profile.opponent} awarded ${context.team} a first down on third down; call correctness requires review.`||reason===`Defensive penalty on ${profile.opponent} awarded ${context.team} a first down on fourth down; call correctness requires review.`))return false;
    const grouped=candidate.reasons.map(reason=>/^(\d+) defensive-penalty first downs on third or fourth down occurred on ([A-Z]+) drive ([1-9]\d*); review the sequence together\.$/.exec(reason)).filter(match=>match!==null);
    if(grouped.length!==1)return false;
    const match=grouped[0];
    if(Number(match[1])!==playIds.length||match[2]!==context.team||(drive!==undefined&&drive!==match[3]))return false;
    drive=match[3];return true;
   });
  });
  if(valid)clusters.push({team:context.team,playIds});
 }
 return clusters.sort((a,b)=>b.playIds.length-a.playIds.length);
}

/** Validate every displayed arithmetic link; missing market evidence never supplies a floor. */
function marketSignal(audit:GameAudit):{floor:1|2|3;reason:string|null}{
 const m=audit.market,r=m?.reference,home=audit.profiles.find(p=>p.team===m?.homeTeam),away=audit.profiles.find(p=>p.team===m?.awayTeam);
 if(!m||m.version!=='under-review-spread-v1'||m.status!=='available'||!r||!home||!away||home.gameId!==away.gameId||home.season!==away.season
  ||!finite(home.pointsFor)||!finite(away.pointsFor)||home.pointsAgainst!==away.pointsFor||away.pointsAgainst!==home.pointsFor
  ||!finite(m.expectedHomeMargin)||!Number.isInteger(m.expectedHomeMargin*2)||Math.abs(m.expectedHomeMargin)>100||m.actualHomeMargin!==home.pointsFor-away.pointsFor
  ||m.homeMarginError!==m.actualHomeMargin-m.expectedHomeMargin||m.absoluteError!==Math.abs(m.homeMarginError)||!m.source||!/^[a-f0-9]{64}$/.test(m.source.checksum)
  ||!/^[a-f0-9]{64}$/.test(r.checksum??'')||!integer(r.games)||r.games<500||!integer(r.atLeastAsSurprising)||r.atLeastAsSurprising>r.games
  ||!integer(r.startSeason)||!integer(r.endSeason)||r.startSeason>r.endSeason||r.endSeason>=home.season||!finite(r.tailRate)||Math.abs(r.tailRate-r.atLeastAsSurprising/r.games)>1e-9
  ||!finite(r.percentile)||Math.abs(r.percentile-100*(1-r.tailRate))>1e-9)return {floor:1,reason:null};
 const floor=r.tailRate<=.05?3:r.tailRate<=.1?2:1;
 if(m.ratingFloor!==floor||m.surprise!==(floor===3?'very_unusual':floor===2?'unusual':'ordinary'))return {floor:1,reason:null};
 return {floor,reason:floor>1?`The final margin was ${m.absoluteError} points from the recorded spread. ${count(r.atLeastAsSurprising)} of ${count(r.games)} prior games (${(100*r.tailRate).toFixed(1)}%) were at least this far from their line.`:null};
}

/** Versioned editorial screening rules, not a probability or finding of manipulation. */
export function getGameVerdict(audit:GameAudit|null|undefined,hasAnalysis=true):GameVerdict{
 const base={comparison:null,rating:null,cluster:null,rulesVersion:SUSPICION_RULES_VERSION,definition:'Outside the five-level scale until the evidence is sufficient.',reviewCount:audit?.reviewCandidates.length??0,evidenceNote:'Automatic screening. Not a finding of manipulation.'} as const;
 if(!hasAnalysis)return {...base,level:'awaiting',label:'Waiting for game data',shortLabel:'Awaiting data',summary:'The report will appear automatically after the game ends and its data passes validation.',reasons:[],tone:'waiting'};
 if(!audit)return {...base,level:'limited',label:'Unrated',shortLabel:'Unrated',summary:'The statistical analysis is complete, but this saved report does not yet include the game-level comparison.',reasons:[],tone:'limited'};
 const invalidFlag=audit.flags.some(flag=>!validFlag(audit,flag));
 const supported=invalidFlag?[]:audit.flags.filter(flag=>supportedFlag(audit,flag));
 const strongest=supported.find(flag=>flag.status==='historical_outlier')??supported.find(flag=>flag.status==='unusual_profile');
 const profiles=audit.profiles;
 const compatible=profiles.length===2&&profiles.every(complete)&&profiles[0].team===profiles[1].opponent&&profiles[1].team===profiles[0].opponent&&profiles[0].gameId===profiles[1].gameId&&profiles[0].season===profiles[1].season&&profiles[0].pointsFor===profiles[1].pointsAgainst&&profiles[1].pointsFor===profiles[0].pointsAgainst&&profiles[0].totalYards===profiles[1].opponentYards&&profiles[1].totalYards===profiles[0].opponentYards&&profiles[0].turnoverMargin===-profiles[1].turnoverMargin!;
 const winner=profiles.find(p=>finite(p.pointsFor)&&finite(p.pointsAgainst)&&p.pointsFor>p.pointsAgainst);
 const sparse=audit.flags.find(flag=>flag.status==='rare_sample'&&validCounts(flag));
 if(!compatible||!hasReference(audit)||invalidFlag||(sparse&&!strongest)||!winner){
  const summary=!compatible?'Some team totals are missing or conflict with the final score, so we cannot reliably grade how unusual the result was.':!hasReference(audit)||invalidFlag?'The historical comparison is unavailable or inconsistent, so we cannot reliably grade this result.':!winner?'This game ended in a tie. The current historical checks grade winning profiles, so they do not rate this result.':`This combination has only ${count(sparse!.reference.matchingGames)} matching games in the historical reference—too few for a reliable unusual-win label.`;
  return {...base,level:'limited',label:'Unrated',shortLabel:'Unrated',summary,reasons:winner?profileFacts(winner):[],comparison:sparse&&hasReference(audit)&&!invalidFlag?comparison(sparse):null,tone:'limited',evidenceNote:base.reviewCount?`${base.reviewCount} ${base.reviewCount===1?'play was':'plays were'} still flagged for a closer look. Missing evidence is not a clean bill of health.`:'The available statistical analysis remains below; missing evidence is not a clean bill of health.'};
 }
 const clusters=driveClusters(audit);
 const winningCluster=clusters.find(cluster=>cluster.team===winner.team&&cluster.playIds.length>=3);
 const outlier=strongest?.status==='historical_outlier';
 const top=outlier&&strongest.team===winner.team&&!!winningCluster;
 const cluster=top?winningCluster!:clusters[0]??null;
 const market=marketSignal(audit);
 const existingRating=top?5:outlier||(cluster&&cluster.playIds.length>=3)?4:strongest||(cluster&&cluster.playIds.length>=2)?3:base.reviewCount?2:1;
 const rating=Math.max(existingRating,market.floor) as 1|2|3|4|5;
 const tier=SUSPICION_SCALE[rating-1];
 const clusterReason=cluster?`${teamName(cluster.team)} received ${cluster.playIds.length} first downs from defensive penalties on third or fourth down during one drive.`:null;
 const historicalReason=strongest?`${teamName(winner.team)} won despite ${strongest.conditions.map(condition=>conditionLabels[condition]).join(' and ')}. Matching past performances produced ${count(strongest.reference.wins)} wins in ${count(strongest.reference.matchingGames)} games.`:null;
 const summary=top?'A rare winning profile and a repeated penalty sequence favored the winner.':outlier?'The winner’s statistical profile rarely produced wins in the historical comparison.':cluster&&cluster.playIds.length>=3?'Three or more defensive penalties extended one drive.':strongest?'The winning performance matches an unusual historical pattern.':cluster?'Repeated defensive penalties extended one drive.':market.floor===3?'The final margin was very unusual compared with the recorded spread.':market.floor===2?'The final margin was unusual compared with the recorded spread.':base.reviewCount?`${base.reviewCount} ${base.reviewCount===1?'play deserves':'plays deserve'} a closer look.`:'No unusual pattern stood out in the available data.';
 return {...base,...tier,shortLabel:tier.label,summary,cluster,comparison:strongest?comparison(strongest):null,reasons:[historicalReason,clusterReason,market.reason,...profileFacts(winner)].filter((reason):reason is string=>!!reason),tone:rating>=4?'high':rating===3?'elevated':'neutral',evidenceNote:'Automatic screening. Not a finding of manipulation. These signals may overlap; the level is not the odds that a game was rigged.'};
}
