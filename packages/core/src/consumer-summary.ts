import type { GameAudit, GameAuditFlag, GameProfile } from './contracts.js';
import { gameExpectationsSchema, type GameExpectations } from './expectations-contracts.js';

export const SUSPICION_RULES_VERSION = 'game-suspicion-v3';
const LEGACY_SCALE = [
 {level:'fair',rating:1,label:'Fair',definition:'No flags within the checks we can run.'},
 {level:'debatable',rating:2,label:'Debatable',definition:'Individual plays deserve a closer look, or the result was unusually far from the recorded spread.'},
 {level:'hmm',rating:3,label:'Hmm',definition:'An unusual win pattern, repeated penalty sequence, or very unusual result versus the spread.'},
 {level:'sus',rating:4,label:'Sus',definition:'A strong statistical flag or three-plus drive-extending penalties.'},
 {level:'extreme',rating:5,label:'RIGGED?',definition:'A strong statistical flag and a three-plus penalty sequence favored the winner.'},
] as const;
export const SUSPICION_SCALE = [
 {level:'fair',rating:1,label:'Fair',definition:'The outcome and penalty pattern fit historical expectations.'},
 {level:'debatable',rating:2,label:'Debatable',definition:'A statistical result stands out after accounting for the comparisons we run.'},
 {level:'hmm',rating:3,label:'Hmm',definition:'A more unusual statistical result, or two drive-extending penalties on one drive.'},
 {level:'sus',rating:4,label:'Sus',definition:'A strong outcome or penalty anomaly, or three-plus drive-extending penalties.'},
 {level:'extreme',rating:5,label:'RIGGED?',definition:'A strong statistical anomaly and a three-plus penalty sequence both favored the winner.'},
] as const;
export type VerdictLevel = typeof SUSPICION_SCALE[number]['level']|'limited'|'awaiting';
export interface GameVerdict {
 level:VerdictLevel;label:string;shortLabel:string;summary:string;reasons:string[];
 rating:1|2|3|4|5|null;definition:string;rulesVersion:'game-suspicion-v2'|'game-suspicion-v3';
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
function marketSignal(audit:GameAudit):{floor:1|2|3;reason:string|null;tailProbability?:number}{
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
 return {floor,tailProbability:(r.atLeastAsSurprising+1)/(r.games+1),reason:floor>1?`The final margin was ${m.absoluteError} points from the recorded spread. ${count(r.atLeastAsSurprising)} of ${count(r.games)} prior games (${(100*r.tailRate).toFixed(1)}%) were at least this far from their line.`:null};
}

/** Versioned editorial screening rules, not a probability or finding of manipulation. */
function legacyVerdict(audit:GameAudit|null|undefined,hasAnalysis=true):GameVerdict{
 const base={comparison:null,rating:null,cluster:null,rulesVersion:'game-suspicion-v2',definition:'Outside the five-level scale until the evidence is sufficient.',reviewCount:audit?.reviewCandidates.length??0,evidenceNote:'Automatic screening. Not a finding of manipulation.'} as const;
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
 const tier=LEGACY_SCALE[rating-1];
 const clusterReason=cluster?`${teamName(cluster.team)} received ${cluster.playIds.length} first downs from defensive penalties on third or fourth down during one drive.`:null;
 const historicalReason=strongest?`${teamName(winner.team)} won despite ${strongest.conditions.map(condition=>conditionLabels[condition]).join(' and ')}. Matching past performances produced ${count(strongest.reference.wins)} wins in ${count(strongest.reference.matchingGames)} games.`:null;
 const summary=top?'A rare winning profile and a repeated penalty sequence favored the winner.':outlier?'The winner’s statistical profile rarely produced wins in the historical comparison.':cluster&&cluster.playIds.length>=3?'Three or more defensive penalties extended one drive.':strongest?'The winning performance matches an unusual historical pattern.':cluster?'Repeated defensive penalties extended one drive.':market.floor===3?'The final margin was very unusual compared with the recorded spread.':market.floor===2?'The final margin was unusual compared with the recorded spread.':base.reviewCount?`${base.reviewCount} ${base.reviewCount===1?'play deserves':'plays deserve'} a closer look.`:'No unusual pattern stood out in the available data.';
 return {...base,...tier,shortLabel:tier.label,summary,cluster,comparison:strongest?comparison(strongest):null,reasons:[historicalReason,clusterReason,market.reason,...profileFacts(winner)].filter((reason):reason is string=>!!reason),tone:rating>=4?'high':rating===3?'elevated':'neutral',evidenceNote:'Automatic screening. Not a finding of manipulation. These signals may overlap; the level is not the odds that a game was rigged.'};
}

const close=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
const sha256=(value:string)=>/^[a-f0-9]{64}$/.test(value);
function validExpectations(e:GameExpectations,home:GameProfile,away:GameProfile):boolean{
 const priorYears=(actual:number[],length:number)=>actual.length===length&&actual.every((year,i)=>year===home.season-length+i&&year>=1999);
 const baseline=(b:GameExpectations['teams'][number]['league'])=>integer(b.games)&&(b.games===0?b.meanPenalties===null&&b.meanPenaltyYards===null:finite(b.meanPenalties)&&b.meanPenalties>=0&&finite(b.meanPenaltyYards)&&b.meanPenaltyYards>=0);
 const tail=(s:GameExpectations['penalty']|GameExpectations['outcome'])=>s.status==='supported'&&s.reasonCode===null&&finite(s.anomalyScore)&&s.anomalyScore>=0
  &&integer(s.calibrationGames)&&s.calibrationGames>=500&&integer(s.atLeastAsUnusual)&&s.atLeastAsUnusual<=s.calibrationGames&&finite(s.tailProbability)
  &&(s.anomalyScore>1e-12||s.atLeastAsUnusual===s.calibrationGames)
  &&close(s.tailProbability,(s.atLeastAsUnusual+1)/(s.calibrationGames+1));
 if(e.version!=='under-review-expectations-v1'||e.reference.version!=='under-review-expectations-reference-v1'||e.status!=='supported'
  ||!priorYears(e.cutoff.trainingSeasons,5)||!priorYears(e.cutoff.calibrationSeasons,3)||!sha256(e.reference.checksum)
  ||!e.reference.sourceUrls.length||new Set(e.reference.sourceUrls).size!==e.reference.sourceUrls.length
  ||e.reference.sourceUrls.some(url=>!url.startsWith('https://')||!sha256(e.reference.sourceChecksums[url]??''))||!tail(e.penalty)||!tail(e.outcome))return false;
 const h=e.teams.find(t=>t.team===home.team),a=e.teams.find(t=>t.team===away.team);
 if(e.teams.length!==2||!h||!a||h===a||!integer(e.outcome.trainingGames)||e.outcome.trainingGames<500||!e.outcome.coefficients)return false;
 const referee=e.referee,withRef=e.penalty.method==='team_opponent_referee';
 if(!['team_opponent','team_opponent_referee'].includes(e.penalty.method)||!baseline(referee.home)||!baseline(referee.away))return false;
 if(withRef){
  if(!['verified','schedule_only'].includes(referee.status)||!referee.name?.trim()||!referee.canonicalId?.trim()||!referee.effect||referee.games<10
   ||referee.home.games!==referee.games||referee.away.games!==referee.games||referee.reasonCode!==null
   ||!finite(referee.meanTotalPenalties)||!finite(referee.meanTotalPenaltyYards)
   ||!close(referee.meanTotalPenalties,referee.home.meanPenalties!+referee.away.meanPenalties!)
   ||!close(referee.meanTotalPenaltyYards,referee.home.meanPenaltyYards!+referee.away.meanPenaltyYards!))return false;
 }else if(referee.effect!==null)return false;
 for(const [team,profile] of [[h,home],[a,away]] as const){
  if(team.opponent!==profile.opponent||team.actual.penalties!==profile.penalties||team.actual.penaltyYards!==profile.penaltyYards
   ||!team.expected||!team.residual||![team.league,team.teamHistory,team.opponentDrawn,team.refereeHistory].every(baseline)
   ||team.league.games<1000||team.league.games%2!==0||team.teamHistory.games>team.league.games/2||team.opponentDrawn.games>team.league.games/2
   ||team.refereeHistory.wins+team.refereeHistory.losses+team.refereeHistory.ties>team.refereeHistory.games)return false;
  for(const key of ['penalties','penaltyYards'] as const){
   const meanKey=key==='penalties'?'meanPenalties':'meanPenaltyYards',league=team.league[meanKey]!;
   const shrunk=(b:typeof team.teamHistory)=>(b.games*(b[meanKey]??0)+20*league)/(b.games+20);
   const expected=Math.max(0,league+0.5*(shrunk(team.teamHistory)-league)+0.5*(shrunk(team.opponentDrawn)-league)+(withRef?referee.effect![key]/2:0));
   if(!close(team.expected[key],expected)||!close(team.residual[key],team.actual[key]!-team.expected[key]))return false;
  }
 }
 if(h.league.games!==a.league.games||!close(h.league.meanPenalties!,a.league.meanPenalties!)||!close(h.league.meanPenaltyYards!,a.league.meanPenaltyYards!))return false;
 const ids=['total_count','total_yards','imbalance_count','imbalance_yards'] as const;
 const actual=[home.penalties!+away.penalties!,home.penaltyYards!+away.penaltyYards!,home.penalties!-away.penalties!,home.penaltyYards!-away.penaltyYards!];
 const expected=[h.expected!.penalties+a.expected!.penalties,h.expected!.penaltyYards+a.expected!.penaltyYards,h.expected!.penalties-a.expected!.penalties,h.expected!.penaltyYards-a.expected!.penaltyYards];
 if(e.penalty.components.length!==4||ids.some((id,i)=>{
  const matching=e.penalty.components.filter(c=>c.id===id),c=matching[0];
  return matching.length!==1||!close(c.actual,actual[i])||!close(c.expected,expected[i])||!close(c.residual,c.actual-c.expected)||!close(c.standardized,c.residual/c.scale);
 }))return false;
 if(!close(e.penalty.anomalyScore!,Math.max(...e.penalty.components.map(c=>Math.abs(c.standardized)))))return false;
 const c=e.outcome.coefficients,predicted=c.intercept+c.yardsPer100*(home.totalYards!-away.totalYards!)/100+c.turnoverMargin*home.turnoverMargin!;
 return e.outcome.actualHomeMargin===home.pointsFor!-away.pointsFor!&&finite(e.outcome.expectedHomeMargin)&&finite(e.outcome.residual)
  &&close(e.outcome.expectedHomeMargin,predicted)&&close(e.outcome.residual,e.outcome.actualHomeMargin!-predicted)&&close(e.outcome.anomalyScore!,Math.abs(e.outcome.residual));
}

/** V3 uses two chronologically calibrated statistical families plus the market.
 * The fixed three-comparison adjustment is conservative even if a line is absent.
 * The ordinal thresholds are editorial, never a probability of misconduct. */
export function getGameVerdict(audit:GameAudit|null|undefined,hasAnalysis=true):GameVerdict{
 if(audit&&/^under-review-game-audit-v[1-4]$/.test(audit.version))return legacyVerdict(audit,hasAnalysis);
 const base:GameVerdict={comparison:null,rating:null,cluster:null,rulesVersion:SUSPICION_RULES_VERSION,definition:'There is not enough consistent evidence for a rating.',reviewCount:audit?.reviewCandidates.length??0,evidenceNote:'The rating measures unusual patterns, not the probability of manipulation.',level:'limited',label:'Unrated',shortLabel:'Unrated',summary:'The expected-versus-actual comparison is not available for this report yet.',reasons:[],tone:'limited'};
 if(!hasAnalysis)return {...base,level:'awaiting',label:'Waiting for game data',shortLabel:'Awaiting data',summary:'The report appears automatically after complete final-game data arrives.',tone:'waiting'};
 if(!audit||audit.version!=='under-review-game-audit-v5')return base;
 const parsed=gameExpectationsSchema.safeParse(audit.expectations);
 if(!parsed.success)return base;
 const e=parsed.data,profiles=audit.profiles,home=profiles.find(p=>p.team===e.homeTeam),away=profiles.find(p=>p.team===e.awayTeam);
 const compatible=profiles.length===2&&profiles.every(complete)&&home&&away&&home.team!==away.team&&home.opponent===away.team&&away.opponent===home.team
  &&home.gameId===e.gameId&&away.gameId===e.gameId&&home.season===away.season&&e.cutoff.targetSeason===home.season
  &&home.pointsFor===away.pointsAgainst&&away.pointsFor===home.pointsAgainst&&home.totalYards===away.opponentYards&&away.totalYards===home.opponentYards&&home.turnoverMargin===-away.turnoverMargin!;
 if(!compatible||!validExpectations(e,home!,away!)){
  return {...base,summary:'Some statistics or historical comparisons are missing or inconsistent. The available figures are shown below.'};
 }
 const market=marketSignal(audit);
 type Signal={kind:'penalty'|'outcome'|'market';tail:number;reason:string};
 const outcomeFavored=e.outcome.residual!>=0?home!.team:away!.team;
 const signals:Signal[]=[
  {kind:'outcome',tail:e.outcome.tailProbability!,reason:`${outcomeFavored} finished ${Math.abs(e.outcome.residual!).toFixed(1)} points above its box-score expectation.`},
  {kind:'penalty',tail:e.penalty.tailProbability!,reason:`Penalty patterns were this unusual in ${e.penalty.atLeastAsUnusual} of ${e.penalty.calibrationGames} comparison games.`},
 ];
 if(market.tailProbability!==undefined)signals.push({kind:'market',tail:market.tailProbability,reason:`The final margin missed the spread by ${audit.market!.absoluteError} points.`});
 const signalRating=(s:Signal):1|2|3|4=>s.tail*3<=.03&&s.kind!=='market'?4:s.tail*3<=.10?3:s.tail*3<=.20?2:1;
 // A market-only cap must not suppress an independently stronger statistical family.
 signals.sort((a,b)=>signalRating(b)-signalRating(a)||a.tail-b.tail);
 const strongest=signals[0],statisticalRating=signalRating(strongest);
 const clusters=driveClusters(audit),winner=profiles.find(p=>p.pointsFor!>p.pointsAgainst!),winningCluster=clusters.find(c=>c.team===winner?.team&&c.playIds.length>=3);
 // An absolute anomaly may favor either side. Only an unusually favorable
 // outcome for the actual winner can corroborate that winner's penalty sequence.
 const extreme=!!winningCluster&&winner?.team===outcomeFavored&&Math.abs(e.outcome.residual!)>0&&e.outcome.tailProbability!*3<=.03;
 const cluster=extreme?winningCluster!:clusters[0]??null;
 const rating=(extreme?5:Math.max(statisticalRating,cluster?(cluster.playIds.length>=3?4:3):1)) as 1|2|3|4|5;
 const tier=SUSPICION_SCALE[rating-1];
 const clusterReason=cluster?`${cluster.playIds.length} defensive penalties extended one ${cluster.team} drive on third or fourth down.`:null;
 const topReason=extreme?`${winner!.team} beat its box-score expectation by ${Math.abs(e.outcome.residual!).toFixed(1)} points; ${winningCluster!.playIds.length} penalties extended one ${winner!.team} drive.`:null;
 const stats=signals.filter(s=>s.tail*3<=.20).map(s=>s.reason);
 const reasons=topReason?[topReason,...stats]:cluster&&rating>statisticalRating?[clusterReason!,...stats]:[...stats,...(clusterReason?[clusterReason]:[])];
 const summary=extreme?'An exceptionally unusual outcome and a repeated penalty sequence both favored the winner.':cluster&&rating>statisticalRating?`${cluster.playIds.length} defensive penalties kept one ${cluster.team} drive alive.`:statisticalRating===1?'The result and penalty pattern fit the usual historical range.':strongest.kind==='penalty'?'The penalty pattern was unusually far from team, opponent and available referee expectations.':strongest.kind==='outcome'?'The final score was unusual given the teams’ yardage and turnovers.':'The final score was unusually far from the pregame spread.';
 return {...base,...tier,shortLabel:tier.label,summary,reasons,cluster,tone:rating>=4?'high':rating===3?'elevated':'neutral'};
}
