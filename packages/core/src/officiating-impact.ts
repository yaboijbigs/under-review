import {penaltyOpportunities,predictPenalty,type FrequencyGame,type FrequencyModel,type FrequencyMode,type CrewMember} from './officiating-frequency.js';
import {estimateState,stateModelInputReason,type OfficiatingStateModel} from './officiating-state-model.js';
import type {OfficiatingGameObservation,OfficiatingOpportunity} from './officiating-observations.js';

export interface ImpactEvent {playId:string;driveId:string|null;team:string;type:string;homeEp:number;homeWp:number|null;observedHomeWpChange:number|null;firstDownExtension:boolean;assumption:string}
type Cost=[calls:number,valued:number,totalCost:number,squaredCost:number];
export interface ImpactModel {targetSeason:number;stateModelChecksum:string;heads:Record<string,Cost>;contexts:Record<string,Cost>}
function valueKey(o:OfficiatingOpportunity,head:string){const s=o.state;return `${head}|${s.down}|${s.yardsToGo!<=3?'short':s.yardsToGo!<=10?'medium':'long'}|${s.yardline100!<=20?'red':s.yardline100!>=80?'backed':'middle'}|${s.halfSecondsRemaining!<=120?'late':'ordinary'}`;}
export function valuePenalty(o:OfficiatingOpportunity,g:OfficiatingGameObservation,model:OfficiatingStateModel):ImpactEvent|null{
  const p=o.penalty;if(o.penaltyStatus!=='accepted'||!p?.actualState||!p.alternativeState)return null;
  const a=estimateState(model,p.actualState,g.homeTeam),b=estimateState(model,p.alternativeState,g.homeTeam);
  if(a.ep===null||b.ep===null)return null;
  const homeEp=a.ep*(p.actualState.possessionTeam===g.homeTeam?1:-1)-b.ep*(p.alternativeState.possessionTeam===g.homeTeam?1:-1);
  // State model noise must not turn a straightforward enforcement into a reward
  // for the penalized side. Unknown alternatives remain excluded, never zero.
  if(!Number.isFinite(homeEp)||Math.abs(homeEp)>14||homeEp*(p.team===g.homeTeam?-1:1)<-1e-9)return null;
  return {playId:o.playId,driveId:o.driveId,team:p.team===g.homeTeam?g.awayTeam:g.homeTeam,type:p.type,homeEp,
    // The experimental WP contrast failed held-out calibration. Keep existing
    // observed momentum as context; do not publish this uncalibrated estimate.
    homeWp:null,observedHomeWpChange:o.observedHomeWpChange,
    firstDownExtension:p.firstDownExtension,assumption:p.assumption??'Enforced state versus the documented alternative; call correctness is not inferred.'};
}
export function fitImpactModel(targetSeason:number,games:FrequencyGame[],states:OfficiatingStateModel):ImpactModel{
  if(states.targetSeason!==targetSeason)throw new Error('Impact training cutoff does not match its state model.');
  const model:ImpactModel={targetSeason,stateModelChecksum:states.checksum,heads:{},contexts:{}};
  for(const {observation:g} of games){if(g.gameType!=='REG'||g.season>=targetSeason||g.season<targetSeason-5)continue;
    for(const o of g.opportunities){const heads=penaltyOpportunities(o,g.homeTeam).filter(p=>p.called);if(!heads.length)continue;
      const event=valuePenalty(o,g,states),cost=event?Math.abs(event.homeEp):null;
      for(const p of heads)for(const [map,key] of [[model.heads,p.head],[model.contexts,valueKey(o,p.head)]] as const){const s=map[key]??(map[key]=[0,0,0,0]);s[0]++;if(cost!==null){s[1]++;s[2]+=cost;s[3]+=cost*cost;}}
    }
  }
  return model;
}
function costFor(model:ImpactModel,o:OfficiatingOpportunity,head:string){
  // The extractor never reconstructs late-half/terminal/invalid states. Do not
  // smooth those structural gaps toward nonzero ordinary-period enforcement.
  if(stateModelInputReason(o.state)||o.state.halfSecondsRemaining!<=120)return null;
  const base=model.heads[head];if(!base||base[0]<20||base[1]<20)return null;
  // Means include known unvalued called events in the denominator because this
  // estimand is the supported enforcement subset, not invented total foul harm.
  const c=model.contexts[valueKey(o,head)],prior=100;
  return {mean:c?(c[2]+prior*base[2]/base[0])/(c[0]+prior):base[2]/base[0],second:c?(c[3]+prior*base[3]/base[0])/(c[0]+prior):base[3]/base[0]};
}
export interface ImpactComparison {actualHomeEp:number;expectedHomeEp:number;excessHomeEp:number;variance:number;statistic:number;favoredTeam:string|null;playIds:string[]}
export interface GameImpactResult {
  gameId:string;season:number;events:ImpactEvent[];game:ImpactComparison;drives:(ImpactComparison&{driveId:string})[];
  maximum:number;strongest:'game'|'drive';strongestDrive:string|null;favoredTeam:string|null;
  rates:{team:string;family:string;opportunities:number;actual:number;expected:number}[];
  coverage:{opportunities:number;modeledOpportunities:number;acceptedPenalties:number;modeledCalls:number;excludedPenalties:number;valuedPenalties:number;statePairs:number;missingDriveOpportunities:number};
  turningPoints:{playId:string;homeWpChange:number;penalty:boolean;driveId:string|null}[];
}
function comparison(actual:number,expected:number,variance:number,playIds:string[],g:OfficiatingGameObservation):ImpactComparison{
  const excess=actual-expected;
  // Both observed net benefit and excess benefit must point the same way. The
  // smaller effect prevents a missing expected penalty from masquerading as an
  // observed gift to the other side. One EP^2 stabilizes sparse opportunities.
  const material=actual*excess>0?Math.min(Math.abs(actual),Math.abs(excess)):0;
  return {actualHomeEp:actual,expectedHomeEp:expected,excessHomeEp:excess,variance,statistic:material/Math.sqrt(1+variance),favoredTeam:material>0?(actual>0?g.homeTeam:g.awayTeam):null,playIds};
}
export function calculateGameImpact(g:OfficiatingGameObservation,frequency:FrequencyModel,states:OfficiatingStateModel,impact:ImpactModel,mode:FrequencyMode='context',crew:CrewMember[]=[]):GameImpactResult{
  if([frequency.targetSeason,states.targetSeason,impact.targetSeason].some(year=>year!==g.season))throw new Error('Officiating model cutoff does not match the target season.');
  if(impact.stateModelChecksum!==states.checksum)throw new Error('Impact costs and event valuation use different state models.');
  const events:ImpactEvent[]=[],rates=new Map<string,GameImpactResult['rates'][number]>(),drives=new Map<string,{actual:number;expected:number;variance:number;playIds:string[]}>();
  let actual=0,expected=0,variance=0,modeledOpportunities=0,modeledCalls=0,missingDriveOpportunities=0;
  for(const o of g.opportunities){const ps=penaltyOpportunities(o,g.homeTeam).filter(p=>predictPenalty(frequency,o,p,mode,crew)!==null);if(!ps.length)continue;modeledOpportunities++;
    let e=0,v=0;for(const p of ps){const probability=predictPenalty(frequency,o,p,mode,crew);if(probability===null)continue;
      const key=`${p.team}|${p.family}`,r=rates.get(key)??{team:p.team,family:p.family,opportunities:0,actual:0,expected:0};r.opportunities++;r.actual+=Number(p.called);r.expected+=probability;rates.set(key,r);if(p.called)modeledCalls++;
      const cost=costFor(impact,o,p.head);if(cost){e+=probability*cost.mean*(p.home?-1:1);v+=Math.max(0,probability*cost.second-(probability*cost.mean)**2);}
    }
    const event=ps.some(p=>p.called&&costFor(impact,o,p.head)!==null)?valuePenalty(o,g,states):null;if(event)events.push(event);const a=event?.homeEp??0;actual+=a;expected+=e;variance+=v;
    if(o.driveId){const d=drives.get(o.driveId)??{actual:0,expected:0,variance:0,playIds:[]};d.actual+=a;d.expected+=e;d.variance+=v;if(event)d.playIds.push(o.playId);drives.set(o.driveId,d);}else missingDriveOpportunities++;
  }
  const whole=comparison(actual,expected,variance,events.map(e=>e.playId),g),sequences=[...drives].map(([driveId,d])=>({driveId,...comparison(d.actual,d.expected,d.variance,d.playIds,g)})).sort((a,b)=>b.statistic-a.statistic||a.driveId.localeCompare(b.driveId));
  const drive=sequences[0],isDrive=!!drive&&drive.statistic>whole.statistic;
  const turningPoints=g.opportunities.filter(o=>o.observedHomeWpChange!==null).sort((a,b)=>Math.abs(b.observedHomeWpChange!)-Math.abs(a.observedHomeWpChange!)||a.order-b.order).slice(0,3).map(o=>({playId:o.playId,homeWpChange:o.observedHomeWpChange!,penalty:o.penaltyStatus!=='none',driveId:o.driveId}));
  return {gameId:g.gameId,season:g.season,events,game:whole,drives:sequences,maximum:isDrive?drive.statistic:whole.statistic,strongest:isDrive?'drive':'game',strongestDrive:isDrive?drive.driveId:null,favoredTeam:isDrive?drive.favoredTeam:whole.favoredTeam,rates:[...rates.values()],
    coverage:{opportunities:g.coverage.regulationOpportunities,modeledOpportunities,acceptedPenalties:g.opportunities.filter(o=>o.state.quarter<=4&&o.penaltyStatus==='accepted').length,modeledCalls,excludedPenalties:g.opportunities.filter(o=>o.state.quarter<=4&&o.penaltyStatus==='excluded').length,valuedPenalties:events.length,statePairs:g.opportunities.filter(o=>o.state.quarter<=4&&o.penalty?.actualState&&o.penalty.alternativeState).length,missingDriveOpportunities},turningPoints};
}
