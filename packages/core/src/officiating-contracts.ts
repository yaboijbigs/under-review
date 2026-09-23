import {z} from 'zod';
export const OFFICIATING_REFERENCE_VERSION='under-review-officiating-reference-v1';
const n=z.number().finite(),count=n.int().nonnegative().max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[a-f0-9]{64}$/);
const id=z.string().min(1).refine(s=>s.trim()===s),season=n.int().min(1900).max(2200);
const family=z.enum(['offensive_hold','defensive_pass','offensive_presnap','defensive_presnap','personal_foul','other_offense','other_defense']);
const comparison=z.object({actualHomeEp:n,expectedHomeEp:n,excessHomeEp:n,variance:n.nonnegative(),statistic:n.nonnegative(),favoredTeam:id.nullable(),playIds:z.array(id)});
export const officiatingResultSchema=z.object({
 gameId:id,season,
 events:z.array(z.object({playId:id,driveId:id.nullable(),team:id,type:id,homeEp:n.min(-14).max(14),homeWp:n.min(-1).max(1).nullable(),observedHomeWpChange:n.min(-1).max(1).nullable(),firstDownExtension:z.boolean(),assumption:id})),
 game:comparison,drives:z.array(comparison.extend({driveId:id})),maximum:n.nonnegative(),strongest:z.enum(['game','drive']),strongestDrive:id.nullable(),favoredTeam:id.nullable(),
 rates:z.array(z.object({team:id,family,opportunities:count,actual:count,expected:n.nonnegative()})),
 coverage:z.object({opportunities:count,modeledOpportunities:count,acceptedPenalties:count,modeledCalls:count,excludedPenalties:count,valuedPenalties:count,statePairs:count,missingDriveOpportunities:count}),
 turningPoints:z.array(z.object({playId:id,homeWpChange:n.min(-1).max(1),penalty:z.boolean(),driveId:id.nullable()})).max(3),
});
export const officiatingAuditSchema=z.object({
 version:z.literal('under-review-officiating-v1'),gameId:id,homeTeam:id,awayTeam:id,season,
 status:z.enum(['supported','limited','unavailable']),reasonCode:id.nullable(),scope:z.literal('supported_regulation_penalty_enforcement'),
 result:officiatingResultSchema.nullable(),
 calibration:z.object({seasons:z.array(season),games:count,atLeastAsUnusual:count,tailProbability:n.min(0).max(1).nullable(),gameAtLeastAsUnusual:count.nullable(),gameTailProbability:n.min(0).max(1).nullable()}),
 reference:z.object({version:z.literal(OFFICIATING_REFERENCE_VERSION),checksum:hash,trainingSeasons:z.array(season),sourceChecksums:z.record(id,hash)}),
 crew:z.object({status:z.enum(['complete','partial','missing','conflict']),adjustmentApplied:z.boolean(),roles:z.array(z.object({role:id,name:id,games:count,actualCallsPerGame:n.nonnegative().nullable(),expectedCallsPerGame:n.nonnegative().nullable(),homeBenefitResidualPerGame:n.nullable()}))}),
 notes:z.array(z.string()),
});
export type OfficiatingAudit=z.infer<typeof officiatingAuditSchema>;

export const OFFICIATING_THRESHOLDS=Object.freeze([{rating:5 as const,tail:.005},{rating:4 as const,tail:.03},{rating:3 as const,tail:.10},{rating:2 as const,tail:.20}]);
export function officiatingTier(tail:number):1|2|3|4|5{return OFFICIATING_THRESHOLDS.find(t=>tail<=t.tail)?.rating??1;}

/** Missing attribution or low coverage must not manufacture a clean bill of health. */
export function impactCoverageReason(result:Pick<z.infer<typeof officiatingResultSchema>,'coverage'>):string|null{
 const c=result.coverage;
 if(c.opportunities<60||c.modeledOpportunities/c.opportunities<.8)return 'insufficient_regulation_opportunity_coverage';
 if(c.acceptedPenalties>0&&c.valuedPenalties===0)return 'no_supported_penalty_values';
 if(c.modeledCalls>c.acceptedPenalties||c.valuedPenalties>c.modeledCalls||c.statePairs<c.valuedPenalties||c.statePairs>c.acceptedPenalties||c.modeledOpportunities>c.opportunities||c.modeledCalls>c.modeledOpportunities||c.missingDriveOpportunities>c.modeledOpportunities||c.acceptedPenalties+c.excludedPenalties>c.opportunities||c.modeledOpportunities+c.excludedPenalties>c.opportunities)return 'inconsistent_coverage';
 if(c.excludedPenalties>Math.max(3,.25*(c.acceptedPenalties+c.excludedPenalties)))return 'too_many_excluded_penalty_plays';
 return null;
}
/** Pure consumer-side arithmetic gate, independent of server-only fitted models. */
export function validOfficiatingAudit(input:unknown):input is OfficiatingAudit{
 const parsed=officiatingAuditSchema.safeParse(input);if(!parsed.success)return false;
 const a=parsed.data,r=a.result,c=a.calibration,close=(x:number,y:number)=>Math.abs(x-y)<1e-7*Math.max(1,Math.abs(x),Math.abs(y));
 const sumClose=(x:number,y:number)=>y===0?x===0:close(x,y);
 const sameIds=(x:string[],y:string[])=>x.length===y.length&&x.every((id,i)=>id===y[i]);
 if(a.status!=='supported'||a.reasonCode!==null||!r||r.gameId!==a.gameId||r.season!==a.season||!a.gameId.startsWith(`${a.season}_`)||a.homeTeam===a.awayTeam||impactCoverageReason(r)||c.games<500||c.atLeastAsUnusual>c.games||c.tailProbability===null||!close(c.tailProbability,(c.atLeastAsUnusual+1)/(c.games+1)))return false;
 if(a.reference.trainingSeasons.length!==5||a.reference.trainingSeasons.some((year,i)=>year!==a.season-5+i)||c.seasons.length!==3||c.seasons.some((year,i)=>year!==a.season-3+i)||Object.keys(a.reference.sourceChecksums).length===0)return false;
 if((c.gameAtLeastAsUnusual===null)!==(c.gameTailProbability===null)||c.gameAtLeastAsUnusual!==null&&(c.gameAtLeastAsUnusual>c.games||!close(c.gameTailProbability!,(c.gameAtLeastAsUnusual+1)/(c.games+1))))return false;
 // Every calibration statistic is nonnegative: zero must count the entire reference population.
 if(r.maximum===0&&c.atLeastAsUnusual!==c.games||r.game.statistic===0&&c.gameAtLeastAsUnusual!==null&&c.gameAtLeastAsUnusual!==c.games)return false;
 const comps=[r.game,...r.drives];
 for(const x of comps){const excess=x.actualHomeEp-x.expectedHomeEp,material=x.actualHomeEp*excess>0?Math.min(Math.abs(x.actualHomeEp),Math.abs(excess)):0;
  if(!sumClose(x.excessHomeEp,excess)||!sumClose(x.statistic,material/Math.sqrt(1+x.variance))||x.favoredTeam!==(material>0?(x.actualHomeEp>0?a.homeTeam:a.awayTeam):null))return false;
  // At most eight modeled penalty heads per opportunity, each with bounded ±14 EP contrasts.
  if(Math.abs(x.expectedHomeEp)>14*8*r.coverage.modeledOpportunities+1e-7||x.variance>196*8*r.coverage.modeledOpportunities+1e-7)return false;
 }
 if(new Set(r.events.map(e=>e.playId)).size!==r.events.length||r.events.length!==r.coverage.valuedPenalties||r.events.some(e=>![a.homeTeam,a.awayTeam].includes(e.team)||e.homeEp*(e.team===a.homeTeam?1:-1)<-1e-9))return false;
 if(!sameIds(r.game.playIds,r.events.map(e=>e.playId))||!sumClose(r.game.actualHomeEp,r.events.reduce((sum,e)=>sum+e.homeEp,0))||r.maximum!==Math.max(...comps.map(x=>x.statistic)))return false;
 const drives=new Map(r.drives.map(d=>[d.driveId,d]));if(drives.size!==r.drives.length)return false;
 if(r.events.some(e=>e.driveId!==null&&!drives.has(e.driveId))||r.events.filter(e=>e.driveId===null).length>r.coverage.missingDriveOpportunities||r.drives.length>r.coverage.modeledOpportunities-r.coverage.missingDriveOpportunities||(r.drives.length===0)!==(r.coverage.modeledOpportunities===r.coverage.missingDriveOpportunities))return false;
 for(const d of r.drives){const events=r.events.filter(e=>e.driveId===d.driveId);
  if(!sameIds(d.playIds,events.map(e=>e.playId))||!sumClose(d.actualHomeEp,events.reduce((sum,e)=>sum+e.homeEp,0)))return false;
 }
 const driveExpected=r.drives.reduce((sum,d)=>sum+d.expectedHomeEp,0),driveVariance=r.drives.reduce((sum,d)=>sum+d.variance,0);
 if(driveVariance>r.game.variance&&!close(driveVariance,r.game.variance))return false;
 if(r.coverage.missingDriveOpportunities===0&&(!close(driveExpected,r.game.expectedHomeEp)||!close(driveVariance,r.game.variance)))return false;
 const missing=r.coverage.missingDriveOpportunities;
 if(Math.abs(r.game.expectedHomeEp-driveExpected)>14*8*missing+1e-7||r.game.variance-driveVariance>196*8*missing+1e-7)return false;
 // Producers choose the game on a tie, otherwise the highest drive, ordered by its ID on a tie.
 const sorted=[...r.drives].sort((x,y)=>y.statistic-x.statistic||x.driveId.localeCompare(y.driveId)),best=sorted[0];
 const isDrive=!!best&&best.statistic>r.game.statistic,strongest=isDrive?best:r.game;
 if(r.strongest!==(isDrive?'drive':'game')||r.strongestDrive!==(isDrive?best.driveId:null)||!close(strongest.statistic,r.maximum)||strongest.favoredTeam!==r.favoredTeam)return false;
 const rates=new Set<string>();let calls=0,opportunities=0;
 for(const rate of r.rates){const key=`${rate.team}|${rate.family}`;
  if(rates.has(key)||![a.homeTeam,a.awayTeam].includes(rate.team)||rate.actual>rate.opportunities||rate.opportunities>r.coverage.modeledOpportunities||rate.expected>rate.opportunities+1e-7)return false;
  rates.add(key);calls+=rate.actual;opportunities+=rate.opportunities;
 }
 if(calls!==r.coverage.modeledCalls||opportunities<r.coverage.modeledOpportunities||opportunities>8*r.coverage.modeledOpportunities)return false;
 for(const team of [a.homeTeam,a.awayTeam])if(r.events.filter(e=>e.team!==team).length>r.rates.filter(p=>p.team===team).reduce((sum,p)=>sum+p.actual,0))return false;
 if(new Set(r.turningPoints.map(p=>p.playId)).size!==r.turningPoints.length)return false;
 for(const p of r.turningPoints){const event=r.events.find(e=>e.playId===p.playId);
  if(event&&(!p.penalty||p.driveId!==event.driveId||event.observedHomeWpChange===null||!close(event.observedHomeWpChange,p.homeWpChange)))return false;
 }
 if(new Set(a.crew.roles.map(r=>r.name)).size!==a.crew.roles.length)return false;
 if(a.crew.roles.some(r=>r.games===0&&(r.actualCallsPerGame!==null||r.expectedCallsPerGame!==null||r.homeBenefitResidualPerGame!==null)))return false;
 if(a.crew.adjustmentApplied&&(a.crew.status!=='complete'||a.crew.roles.filter(r=>r.games>=20).length<5))return false;
 return true;
}
