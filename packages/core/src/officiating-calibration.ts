import {impactCoverageReason,officiatingTier,type OfficiatingAudit} from './officiating-contracts.js';
import type {GameImpactResult} from './officiating-impact.js';

export interface CalibrationGame {gameId:string;season:number;maximum:number;gameStatistic:number}
export function calibrationGame(result:GameImpactResult):CalibrationGame|null{
  if(impactCoverageReason(result))return null;
  return {gameId:result.gameId,season:result.season,maximum:result.maximum,gameStatistic:result.game.statistic};
}
/** Earlier games were predicted using their own earlier-season fits. The joint
 * maximum accounts for searching across the whole game and all observed drives. */
export function calibrateImpact(result:GameImpactResult,history:CalibrationGame[]):OfficiatingAudit['calibration']{
  if(!Number.isInteger(result.season)||!Number.isFinite(result.maximum)||!Number.isFinite(result.game.statistic)||result.maximum<result.game.statistic||result.game.statistic<0)throw new Error('Invalid target officiating calibration statistic.');
  const seasons=Array.from({length:3},(_,i)=>result.season-3+i),ids=new Set<string>();
  const eligible=history.filter(g=>{
    if(!seasons.includes(g.season)||g.gameId===result.gameId)return false;
    if(ids.has(g.gameId))throw new Error(`Duplicate officiating calibration game: ${g.gameId}`);
    ids.add(g.gameId);
    if(!Number.isFinite(g.maximum)||!Number.isFinite(g.gameStatistic)||g.maximum<g.gameStatistic||g.gameStatistic<0)throw new Error('Invalid officiating calibration statistic.');
    return true;
  });
  const atLeastAsUnusual=eligible.filter(g=>g.maximum>=result.maximum).length,gameAtLeastAsUnusual=eligible.filter(g=>g.gameStatistic>=result.game.statistic).length;
  const supported=!impactCoverageReason(result)&&eligible.length>=500&&seasons.every(year=>eligible.some(g=>g.season===year));
  return {seasons,games:eligible.length,atLeastAsUnusual,gameAtLeastAsUnusual:supported?gameAtLeastAsUnusual:null,tailProbability:supported?(atLeastAsUnusual+1)/(eligible.length+1):null,gameTailProbability:supported?(gameAtLeastAsUnusual+1)/(eligible.length+1):null};
}
export function calibratedRating(result:GameImpactResult,history:CalibrationGame[]):1|2|3|4|5|null{
  const c=calibrateImpact(result,history);return c.tailProbability===null?null:officiatingTier(c.tailProbability);
}
