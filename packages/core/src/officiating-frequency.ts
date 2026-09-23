import type { OfficiatingGameObservation, OfficiatingOpportunity, PenaltyFamily } from './officiating-observations.js';

/** Called-penalty rates, not latent infraction or incorrect-call probabilities. */
export const FREQUENCY_VERSION = 'conditional-penalty-opportunities-v1';
export interface CrewMember { role: string; name: string }
export interface FrequencyGame { observation: OfficiatingGameObservation; crew: CrewMember[]; crewStatus?:'complete'|'partial'|'missing'|'conflict' }
type Count = [opportunities: number, calls: number];
type Residual = [opportunities: number, calls: number, expected: number];
export interface FrequencyModel {
  version: typeof FREQUENCY_VERSION; targetSeason: number; trainingSeasons: number[]; games: number;
  prior: number; base: Record<string, Count>; coarse: Record<string, Count>; context: Record<string, Count>;
  teams: Record<string, Residual>; opponents: Record<string, Residual>;
  crew: Record<string, { games: number; opportunities: number; actual: number; expected: number; homeBenefitResidual: number }>;
}
export type FrequencyMode = 'league' | 'team' | 'context' | 'crew';
export interface PenaltyOpportunity { head: string; family: PenaltyFamily; team: string; opponent: string; home: boolean; called: boolean }
const heads: { family: PenaltyFamily; defense: boolean; passOnly?: boolean }[] = [
  {family:'offensive_hold',defense:false}, {family:'defensive_pass',defense:true,passOnly:true},
  {family:'offensive_presnap',defense:false}, {family:'defensive_presnap',defense:true},
  {family:'personal_foul',defense:false}, {family:'personal_foul',defense:true},
  {family:'other_offense',defense:false}, {family:'other_defense',defense:true},
];
const clamp=(p:number)=>Math.max(0.00001,Math.min(.45,p));
const canonicalTeam=(s:string)=>({OAK:'LV',SD:'LAC',STL:'LA',LAR:'LA',JAC:'JAX',WSH:'WAS'}[s]??s);
export function penaltyOpportunities(o:OfficiatingOpportunity, homeTeam:string):PenaltyOpportunity[] {
  if(o.penaltyStatus==='excluded'||o.state.quarter>4||o.state.yardsToGo===null||o.state.yardline100===null||o.state.halfSecondsRemaining===null||o.state.gameSecondsRemaining===null||o.state.scoreDifference===null)return [];
  return heads.filter(h=>h.family.endsWith('_presnap')||o.playKind!=='unknown'&&(!h.passOnly||o.playKind==='pass')).map(h=>{
    const team=h.defense?o.state.defenseTeam:o.state.possessionTeam, opponent=h.defense?o.state.possessionTeam:o.state.defenseTeam;
    return {head:`${h.family}:${h.defense?'d':'o'}`,family:h.family,team,opponent,home:team===homeTeam,called:o.penaltyStatus==='accepted'&&o.penalty?.family===h.family&&o.penalty.team===team};
  });
}
function keys(o:OfficiatingOpportunity,p:PenaltyOpportunity){
  const s=o.state,distance=s.yardsToGo!<=3?'short':s.yardsToGo!<=10?'medium':'long';
  // Unknown play kind on a false start is a consequence of the whistle, not a
  // preplay predictor. Presnap heads therefore use every scrimmage opportunity.
  const kind=p.family.endsWith('_presnap')?'scrimmage':o.playKind;
  const coarse=`${p.head}|${kind}|${s.down}|${distance}`;
  const field=s.yardline100!<=20?'red':s.yardline100!>=80?'backed':'middle';
  const time=s.gameSecondsRemaining!<=300?'late':s.halfSecondsRemaining!<=120?'half-end':'ordinary';
  const score=s.scoreDifference!*(p.team===s.possessionTeam?1:-1), situation=score<-8?'trailing':score>8?'leading':'close';
  return {coarse,context:`${coarse}|${field}|${time}|${situation}|${p.home?'home':'away'}`};
}
const add=(map:Record<string,Count>,key:string,y:number)=>{const c=map[key]??(map[key]=[0,0]);c[0]++;c[1]+=y;};
function baseRate(m:FrequencyModel,head:string){const c=m.base[head];return c?(c[1]+.5)/(c[0]+1):null;}
function contextRate(m:FrequencyModel,o:OfficiatingOpportunity,p:PenaltyOpportunity){
  const base=baseRate(m,p.head);if(base===null)return null;const k=keys(o,p),c=m.coarse[k.coarse],f=m.context[k.context];
  const parent=c?(c[1]+m.prior*base)/(c[0]+m.prior):base;
  return f?(f[1]+m.prior*parent)/(f[0]+m.prior):parent;
}
function ratio(sum:Residual|undefined,base:number,unconditional=false){return sum?(sum[1]+1000*base)/((unconditional?sum[0]*base:sum[2])+1000*base):1;}
/** Team/opponent multipliers are heavily pooled residual effects after context. */
export function predictPenalty(m:FrequencyModel,o:OfficiatingOpportunity,p:PenaltyOpportunity,mode:FrequencyMode='context',crew:CrewMember[]=[]):number|null{
  const base=baseRate(m,p.head);if(base===null||m.games<250)return null;
  if(mode==='league')return clamp(base);
  let value=mode==='team'?base:contextRate(m,o,p)!;
  value*=Math.sqrt(ratio(m.teams[`${p.head}|${canonicalTeam(p.team)}`],base,mode==='team')*ratio(m.opponents[`${p.head}|${canonicalTeam(p.opponent)}`],base,mode==='team'));
  if(mode==='crew'){
    // Symmetric strictness only. Directional effects remain separately visible.
    const effects=crew.map(c=>m.crew[`${c.role}|${c.name}`]).filter(c=>c&&c.games>=20);
    if(effects.length>=5)value*=Math.exp(effects.reduce((sum,c)=>sum+Math.log((c.actual+200)/(c.expected+200)),0)/effects.length);
  }
  return clamp(value);
}
export function fitFrequencyModel(targetSeason:number,games:FrequencyGame[],prior=200):FrequencyModel{
  const priorGames=games.filter(g=>g.observation.season<targetSeason&&g.observation.season>=targetSeason-5&&g.observation.gameType==='REG');
  const m:FrequencyModel={version:FREQUENCY_VERSION,targetSeason,trainingSeasons:[...new Set(priorGames.map(g=>g.observation.season))].sort(),games:priorGames.length,prior,base:{},coarse:{},context:{},teams:{},opponents:{},crew:{}};
  for(const {observation:g} of priorGames)for(const o of g.opportunities)for(const p of penaltyOpportunities(o,g.homeTeam)){
    const y=Number(p.called),k=keys(o,p);add(m.base,p.head,y);add(m.coarse,k.coarse,y);add(m.context,k.context,y);
  }
  for(const {observation:g} of priorGames)for(const o of g.opportunities)for(const p of penaltyOpportunities(o,g.homeTeam)){
    const expected=contextRate(m,o,p)!;
    for(const [map,key] of [[m.teams,`${p.head}|${canonicalTeam(p.team)}`],[m.opponents,`${p.head}|${canonicalTeam(p.opponent)}`]] as const){
      const s=map[key]??(map[key]=[0,0,0]);s[0]++;s[1]+=Number(p.called);s[2]+=expected;
    }
  }
  for(const {observation:g,crew,crewStatus} of priorGames){
    if(crewStatus==='conflict')continue;
    let n=0,actual=0,expected=0,direction=0;
    for(const o of g.opportunities)for(const p of penaltyOpportunities(o,g.homeTeam)){
      const prediction=predictPenalty(m,o,p,'context')!;n++;actual+=Number(p.called);expected+=prediction;direction+=(Number(p.called)-prediction)*(p.home?-1:1);
    }
    for(const c of crew){const k=`${c.role}|${c.name}`,s=m.crew[k]??(m.crew[k]={games:0,opportunities:0,actual:0,expected:0,homeBenefitResidual:0});s.games++;s.opportunities+=n;s.actual+=actual;s.expected+=expected;s.homeBenefitResidual+=direction;}
  }
  return m;
}
export function frequencyDiagnostics(model:FrequencyModel,games:FrequencyGame[],mode:FrequencyMode){
  let n=0,actual=0,predicted=0,logLoss=0,brier=0;const byFamily:Record<string,{n:number;actual:number;expected:number;logLoss:number;brier:number}>={},byGame:{gameId:string;n:number;logLoss:number;brier:number}[]=[];
  for(const {observation:g,crew,crewStatus} of games){if(g.season!==model.targetSeason)continue;
    const game={gameId:g.gameId,n:0,logLoss:0,brier:0};
    for(const o of g.opportunities)for(const p of penaltyOpportunities(o,g.homeTeam)){
      const probability=predictPenalty(model,o,p,mode,crewStatus==='conflict'?[]:crew);if(probability===null)continue;const y=Number(p.called);n++;actual+=y;predicted+=probability;
      const loss=-y*Math.log(probability)-(1-y)*Math.log(1-probability),error=(y-probability)**2;logLoss+=loss;brier+=error;game.n++;game.logLoss+=loss;game.brier+=error;
      const f=byFamily[p.head]??(byFamily[p.head]={n:0,actual:0,expected:0,logLoss:0,brier:0});f.n++;f.actual+=y;f.expected+=probability;f.logLoss+=loss;f.brier+=error;
    }
    byGame.push(game);
  }
  return {opportunities:n,calls:actual,expectedCalls:predicted,logLoss:n?logLoss/n:null,brier:n?brier/n:null,byFamily,byGame};
}

/** Stable half-sample check, diagnostic only: officials are not individual flag attribution. */
export function crewRepeatability(earlier:FrequencyModel,later:FrequencyModel){
  if(earlier.trainingSeasons.some(year=>later.trainingSeasons.includes(year)))throw new Error('Crew repeatability requires disjoint training seasons.');
  const pairs=Object.entries(earlier.crew).flatMap(([key,a])=>{const b=later.crew[key];return a.games>=20&&b?.games>=20?[[a.homeBenefitResidual/(a.games+40),b.homeBenefitResidual/(b.games+40)]]:[];});
  if(pairs.length<10)return {officials:pairs.length,correlation:null};
  const x=pairs.reduce((s,p)=>s+p[0],0)/pairs.length,y=pairs.reduce((s,p)=>s+p[1],0)/pairs.length;
  const cov=pairs.reduce((s,p)=>s+(p[0]-x)*(p[1]-y),0),vx=pairs.reduce((s,p)=>s+(p[0]-x)**2,0),vy=pairs.reduce((s,p)=>s+(p[1]-y)**2,0);
  return {officials:pairs.length,correlation:vx*vy>0?cov/Math.sqrt(vx*vy):null};
}
