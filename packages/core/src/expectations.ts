import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {Game,GameProfile} from './contracts.js';
import {gameExpectationsSchema,type GameExpectations,type ExpectationTail} from './expectations-contracts.js';

export const EXPECTATIONS_VERSION='under-review-expectations-v1';
export const EXPECTATIONS_REFERENCE_VERSION='under-review-expectations-reference-v1';
export const EXPECTATIONS_PARAMETERS=Object.freeze({trainingYears:5,calibrationYears:3,teamPriorGames:20,refereePriorGames:40,minCalibrationGames:500,minTrainingGames:500,minRefereeGames:10});
const number=z.number().finite(),stat=number.nullable(),score=z.number().int().nonnegative().nullable();
export const expectationReferenceRowSchema=z.object({gameId:z.string(),season:z.number().int(),homeTeam:z.string(),awayTeam:z.string(),homeScore:score,awayScore:score,homeYards:stat,awayYards:stat,homeTurnoverMargin:stat,homePenalties:score,awayPenalties:score,homePenaltyYards:score,awayPenaltyYards:score});
const assignmentSchema=z.object({gameId:z.string(),season:z.number().int(),name:z.string().nullable(),canonicalId:z.string().nullable(),status:z.enum(['verified','schedule_only','conflict','missing']),scheduleName:z.string().nullable(),officialName:z.string().nullable(),officialId:z.string().nullable(),officialEra:z.string().nullable()});
export const expectationsReferenceSchema=z.object({schemaVersion:z.literal(1),version:z.literal(EXPECTATIONS_REFERENCE_VERSION),startSeason:z.number().int(),endSeason:z.number().int(),rows:z.array(expectationReferenceRowSchema),assignments:z.array(assignmentSchema),aliases:z.record(z.string(),z.string()),sourceUrls:z.array(z.string()),sourceChecksums:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)),notes:z.array(z.string())});
export type ExpectationsReference=z.infer<typeof expectationsReferenceSchema>;
export interface LoadedExpectationsReference {reference:ExpectationsReference;checksum:string}
type Row=z.infer<typeof expectationReferenceRowSchema>;
type Assignment=z.infer<typeof assignmentSchema>;
type Pair={penalties:number;penaltyYards:number};
type Sum={games:number;penalties:number;penaltyYards:number};
type TeamRef=Sum&{wins:number;losses:number;ties:number};
type RefStats={games:number;total:Sum;home:Sum;away:Sum;residual:Pair;teams:Map<string,TeamRef>};
type Coefficients={intercept:number;yardsPer100:number;turnoverMargin:number};
type Model={season:number;trainingSeasons:number[];rows:Row[];league:Sum;teams:Map<string,Sum>;drawn:Map<string,Sum>;refs:Map<string,RefStats>;scales:{base:(number|null)[];ref:(number|null)[]};coefficients:Coefficients|null;outcomeGames:number};
const aliases:Record<string,string>={OAK:'LV',SD:'LAC',STL:'LA',LAR:'LA',JAC:'JAX',WSH:'WAS'};
export const expectationTeam=(team:string)=>aliases[team]??team;
const blank=():Sum=>({games:0,penalties:0,penaltyYards:0});
const blankTeamRef=():TeamRef=>({...blank(),wins:0,losses:0,ties:0});
const mean=(sum:Sum)=>({games:sum.games,meanPenalties:sum.games?sum.penalties/sum.games:null,meanPenaltyYards:sum.games?sum.penaltyYards/sum.games:null});
function add(sum:Sum,penalties:number,penaltyYards:number){sum.games++;sum.penalties+=penalties;sum.penaltyYards+=penaltyYards;}
const valid=(...values:(number|null)[])=>values.every(value=>value!==null&&Number.isFinite(value));
const penaltyReady=(row:Row)=>valid(row.homePenalties,row.awayPenalties,row.homePenaltyYards,row.awayPenaltyYards);
const outcomeReady=(row:Row)=>valid(row.homeScore,row.awayScore,row.homeYards,row.awayYards,row.homeTurnoverMargin);
const years=(end:number,n:number)=>Array.from({length:n},(_,index)=>end-n+index);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
// Re-read and hash the bytes on every load; equal bytes reuse immutable references and their fitted caches.
const loadedReferences=new Map<string,LoadedExpectationsReference>();
export async function loadExpectationsReference(file=fileURLToPath(new URL('../reference/expectations-reference.json',import.meta.url))):Promise<LoadedExpectationsReference>{
 const bytes=await readFile(file);if(bytes.length>12_000_000)throw new Error('Expectations reference exceeds its size bound.');
 const checksum=createHash('sha256').update(bytes).digest('hex'),cached=loadedReferences.get(checksum);if(cached)return cached;
 const reference=expectationsReferenceSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(reference.startSeason!==1999||reference.endSeason!==2025)throw new Error('Unexpected expectations reference years.');
 const ids=new Set<string>();for(const row of reference.rows){if(ids.has(row.gameId)||row.season<reference.startSeason||row.season>reference.endSeason||row.homeTeam===row.awayTeam||!row.gameId.startsWith(`${row.season}_`))throw new Error('Invalid expectations game identity.');ids.add(row.gameId);}
 const assignments=new Set<string>();for(const row of reference.assignments){if(assignments.has(row.gameId)||!row.gameId.startsWith(`${row.season}_`)||((row.status==='verified'||row.status==='schedule_only')&&(!row.name||!row.canonicalId)))throw new Error('Invalid referee attribution.');assignments.add(row.gameId);}
 if(reference.sourceUrls.some(url=>!reference.sourceChecksums[url]))throw new Error('Expectations source checksum is missing.');
 const loaded=freeze({reference,checksum});loadedReferences.set(checksum,loaded);if(loadedReferences.size>4)loadedReferences.delete(loadedReferences.keys().next().value!);return loaded;
}
export function canonicalReferee(name:unknown,reference:ExpectationsReference):string|null{
 if(typeof name!=='string'||!name.trim())return null;const value=name.trim().replace(/\s+/g,' ');return reference.aliases[value]??value;
}
const refereeId=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
const indexes=new WeakMap<ExpectationsReference,Map<string,Assignment>>();
function assignments(reference:ExpectationsReference){let map=indexes.get(reference);if(!map){map=new Map(reference.assignments.map(row=>[row.gameId,row]));indexes.set(reference,map);}return map;}
export function expectationReferee(game:Pick<Game,'id'|'season'|'providerData'>,reference:ExpectationsReference):Assignment{
 const previous=assignments(reference).get(game.id),raw=canonicalReferee(game.providerData.referee,reference);
 const official=canonicalReferee(previous?.officialName,reference);
 const conflict=previous?.status==='conflict'||!!(raw&&official&&raw!==official);
 const name=raw??previous?.name??null;
 return {gameId:game.id,season:game.season,name,canonicalId:conflict||!name?null:refereeId(name),status:conflict?'conflict':official?'verified':name?'schedule_only':'missing',scheduleName:raw??previous?.scheduleName??null,officialName:previous?.officialName??null,officialId:previous?.officialId??null,officialEra:previous?.officialEra??null};
}
function teamExpected(model:Model,team:string,opponent:string):Pair|null{
 if(!model.league.games)return null;
 const own=model.teams.get(expectationTeam(team))??blank(),drawn=model.drawn.get(expectationTeam(opponent))??blank();
 const compute=(key:'penalties'|'penaltyYards')=>{const league=model.league[key]/model.league.games;const prior=EXPECTATIONS_PARAMETERS.teamPriorGames;return league+0.5*((own[key]+prior*league)/(own.games+prior)-league)+0.5*((drawn[key]+prior*league)/(drawn.games+prior)-league);};
 return {penalties:compute('penalties'),penaltyYards:compute('penaltyYards')};
}
function referenceRef(row:Row,reference:ExpectationsReference){const ref=assignments(reference).get(row.gameId);return ref&&(ref.status==='verified'||ref.status==='schedule_only')?ref.canonicalId:null;}
function refEffect(model:Model,id:string|null):Pair|null{const ref=id?model.refs.get(id):null;if(!ref||ref.games<EXPECTATIONS_PARAMETERS.minRefereeGames)return null;return {penalties:ref.residual.penalties/(ref.games+EXPECTATIONS_PARAMETERS.refereePriorGames),penaltyYards:ref.residual.penaltyYards/(ref.games+EXPECTATIONS_PARAMETERS.refereePriorGames)};}
function prediction(model:Model,row:Row,refId:string|null,useRef:boolean){
 const home=teamExpected(model,row.homeTeam,row.awayTeam),away=teamExpected(model,row.awayTeam,row.homeTeam);if(!home||!away)return null;
 const effect=useRef?refEffect(model,refId):null;if(useRef&&!effect)return null;
 for(const p of [home,away]){if(effect){p.penalties=Math.max(0,p.penalties+effect.penalties/2);p.penaltyYards=Math.max(0,p.penaltyYards+effect.penaltyYards/2);}}
 return {home,away,effect};
}
function penaltyComponents(row:Row,expected:NonNullable<ReturnType<typeof prediction>>){
 const actual=[row.homePenalties!+row.awayPenalties!,row.homePenaltyYards!+row.awayPenaltyYards!,row.homePenalties!-row.awayPenalties!,row.homePenaltyYards!-row.awayPenaltyYards!];
 const projected=[expected.home.penalties+expected.away.penalties,expected.home.penaltyYards+expected.away.penaltyYards,expected.home.penalties-expected.away.penalties,expected.home.penaltyYards-expected.away.penaltyYards];
 return actual.map((value,index)=>({actual:value,expected:projected[index],residual:value-projected[index]}));
}
function sd(values:number[]):number|null{if(values.length<2)return null;const average=values.reduce((sum,v)=>sum+v,0)/values.length;const value=Math.sqrt(values.reduce((sum,v)=>sum+(v-average)**2,0)/(values.length-1));return value>1e-9?value:null;}
/** OLS with an intercept and two fixed predictors; no target/future rows enter fitting. */
function fitOutcome(rows:Row[]):Coefficients|null{
 if(rows.length<EXPECTATIONS_PARAMETERS.minTrainingGames)return null;
 const a=Array.from({length:3},()=>[0,0,0,0]);
 for(const row of rows){const x=[1,(row.homeYards!-row.awayYards!)/100,row.homeTurnoverMargin!],y=row.homeScore!-row.awayScore!;for(let i=0;i<3;i++){for(let j=0;j<3;j++)a[i][j]+=x[i]*x[j];a[i][3]+=x[i]*y;}}
 for(let i=0;i<3;i++){let pivot=i;for(let j=i+1;j<3;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;[a[i],a[pivot]]=[a[pivot],a[i]];const divisor=a[i][i];if(Math.abs(divisor)<1e-9)return null;for(let j=i;j<4;j++)a[i][j]/=divisor;for(let k=0;k<3;k++){if(k===i)continue;const factor=a[k][i];for(let j=i;j<4;j++)a[k][j]-=factor*a[i][j];}}
 const result={intercept:a[0][3],yardsPer100:a[1][3],turnoverMargin:a[2][3]};return Object.values(result).every(Number.isFinite)?result:null;
}
const projectOutcome=(row:Row,c:Coefficients)=>c.intercept+c.yardsPer100*(row.homeYards!-row.awayYards!)/100+c.turnoverMargin*row.homeTurnoverMargin!;
const models=new WeakMap<ExpectationsReference,Map<number,Model>>();
function modelFor(season:number,reference:ExpectationsReference):Model{
 let cache=models.get(reference);if(!cache){cache=new Map();models.set(reference,cache);}const cached=cache.get(season);if(cached)return cached;
 const trainingSeasons=years(season,5),completeWindow=trainingSeasons.every(year=>year>=reference.startSeason&&year<=reference.endSeason&&reference.rows.some(row=>row.season===year)),rows=completeWindow?reference.rows.filter(row=>trainingSeasons.includes(row.season)):[];
 const model:Model={season,trainingSeasons,rows,league:blank(),teams:new Map(),drawn:new Map(),refs:new Map(),scales:{base:[null,null,null,null],ref:[null,null,null,null]},coefficients:null,outcomeGames:0};
 const penaltyRows=rows.filter(penaltyReady);
 for(const row of penaltyRows){for(const home of [true,false]){const team=expectationTeam(home?row.homeTeam:row.awayTeam),opponent=expectationTeam(home?row.awayTeam:row.homeTeam),n=home?row.homePenalties!:row.awayPenalties!,yards=home?row.homePenaltyYards!:row.awayPenaltyYards!;add(model.league,n,yards);const own=model.teams.get(team)??blank();add(own,n,yards);model.teams.set(team,own);const drawn=model.drawn.get(opponent)??blank();add(drawn,n,yards);model.drawn.set(opponent,drawn);}}
 for(const row of penaltyRows){const id=referenceRef(row,reference);if(!id)continue;const base=prediction(model,row,null,false);if(!base)continue;
  const ref=model.refs.get(id)??{games:0,total:blank(),home:blank(),away:blank(),residual:{penalties:0,penaltyYards:0},teams:new Map()};ref.games++;
  add(ref.total,row.homePenalties!+row.awayPenalties!,row.homePenaltyYards!+row.awayPenaltyYards!);add(ref.home,row.homePenalties!,row.homePenaltyYards!);add(ref.away,row.awayPenalties!,row.awayPenaltyYards!);
  ref.residual.penalties+=row.homePenalties!+row.awayPenalties!-base.home.penalties-base.away.penalties;ref.residual.penaltyYards+=row.homePenaltyYards!+row.awayPenaltyYards!-base.home.penaltyYards-base.away.penaltyYards;
  for(const home of [true,false]){const team=expectationTeam(home?row.homeTeam:row.awayTeam),history=ref.teams.get(team)??blankTeamRef();add(history,home?row.homePenalties!:row.awayPenalties!,home?row.homePenaltyYards!:row.awayPenaltyYards!);if(valid(row.homeScore,row.awayScore)){const margin=(row.homeScore!-row.awayScore!)*(home?1:-1);if(margin>0)history.wins++;else if(margin<0)history.losses++;else history.ties++;}ref.teams.set(team,history);}model.refs.set(id,ref);
 }
 for(const mode of ['base','ref'] as const){const residuals:number[][]=[[],[],[],[]];for(const row of penaltyRows){const p=prediction(model,row,referenceRef(row,reference),mode==='ref');if(p)penaltyComponents(row,p).forEach((c,i)=>residuals[i].push(c.residual));}model.scales[mode]=residuals.map(sd);}
 const outcomes=rows.filter(outcomeReady);model.outcomeGames=outcomes.length;model.coefficients=fitOutcome(outcomes);cache.set(season,model);return model;
}
function penaltyStatistic(row:Row,model:Model,reference:ExpectationsReference,useRef:boolean,id=referenceRef(row,reference)){
 if(model.league.games/2<EXPECTATIONS_PARAMETERS.minTrainingGames||!penaltyReady(row))return null;const p=prediction(model,row,id,useRef);if(!p)return null;
 const scales=model.scales[useRef?'ref':'base'];if(scales.some(v=>v===null))return null;
 const ids=['total_count','total_yards','imbalance_count','imbalance_yards'] as const;
 const components=penaltyComponents(row,p).map((c,i)=>({...c,id:ids[i],scale:scales[i]!,standardized:c.residual/scales[i]!}));
 return {components,score:Math.max(...components.map(c=>Math.abs(c.standardized))),prediction:p};
}
type Calibration={base:number[];ref:number[];outcome:number[]};
const calibrations=new WeakMap<ExpectationsReference,Map<number,Calibration>>();
function calibrationFor(season:number,reference:ExpectationsReference):Calibration{
 let cache=calibrations.get(reference);if(!cache){cache=new Map();calibrations.set(reference,cache);}const saved=cache.get(season);if(saved)return saved;
 const result:Calibration={base:[],ref:[],outcome:[]};for(const year of years(season,3)){const model=modelFor(year,reference);for(const row of reference.rows.filter(row=>row.season===year)){for(const type of ['base','ref'] as const){const statistic=penaltyStatistic(row,model,reference,type==='ref');if(statistic)result[type].push(statistic.score);}if(model.coefficients&&outcomeReady(row))result.outcome.push(Math.abs(row.homeScore!-row.awayScore!-projectOutcome(row,model.coefficients)));}}
 cache.set(season,result);return result;
}
export function empiricalExpectationTail(score:number|null,calibration:number[],reason='missing_inputs'):ExpectationTail{
 const count=score===null?0:calibration.filter(value=>value>=score-1e-12).length;
 return {status:score!==null&&calibration.length>=500?'supported':'unavailable',reasonCode:score===null?reason:calibration.length<500?'insufficient_chronological_calibration':null,anomalyScore:score,tailProbability:score!==null&&calibration.length>=500?(count+1)/(calibration.length+1):null,calibrationGames:calibration.length,atLeastAsUnusual:count};
}
function targetRow(game:Game,profiles:GameProfile[]):Row|null{
 const matching=profiles.filter(p=>p.gameId===game.id&&p.season===game.season);if(matching.length!==2)return null;
 const h=matching.find(p=>expectationTeam(p.team)===expectationTeam(game.homeTeam)),a=matching.find(p=>expectationTeam(p.team)===expectationTeam(game.awayTeam));
 if(!h||!a||h===a||expectationTeam(h.opponent)!==expectationTeam(a.team)||expectationTeam(a.opponent)!==expectationTeam(h.team)||game.homeScore===null||game.awayScore===null||h.pointsFor!==game.homeScore||a.pointsFor!==game.awayScore||h.pointsAgainst!==a.pointsFor||a.pointsAgainst!==h.pointsFor)return null;
 if(h.turnoverMargin!==null&&a.turnoverMargin!==null&&h.turnoverMargin!==-a.turnoverMargin)return null;
 if(h.totalYards!==null&&a.opponentYards!==null&&h.totalYards!==a.opponentYards||a.totalYards!==null&&h.opponentYards!==null&&a.totalYards!==h.opponentYards)return null;
 return expectationReferenceRowSchema.parse({gameId:game.id,season:game.season,homeTeam:game.homeTeam,awayTeam:game.awayTeam,homeScore:game.homeScore,awayScore:game.awayScore,homeYards:h.totalYards,awayYards:a.totalYards,homeTurnoverMargin:h.turnoverMargin,homePenalties:h.penalties,awayPenalties:a.penalties,homePenaltyYards:h.penaltyYards,awayPenaltyYards:a.penaltyYards});
}
/** Pure deterministic inference. Outcome expectation conditions on the final box score. */
export function buildExpectations(game:Game,profiles:GameProfile[],loaded:LoadedExpectationsReference):GameExpectations{
 const {reference}=loaded,model=modelFor(game.season,reference),calibration=calibrationFor(game.season,reference),attribution=expectationReferee(game,reference);
 const row=targetRow(game,profiles),regular=game.gameType==='REG',id=attribution.canonicalId,ref=id?model.refs.get(id):undefined,effect=refEffect(model,id),useRef=!!effect;
 const predicted=row?prediction(model,row,id,useRef):null;
 const penalty=regular&&row?penaltyStatistic(row,model,reference,useRef,id):null;
 const actualMargin=valid(game.homeScore,game.awayScore)?game.homeScore!-game.awayScore!:null;
 const expectedMargin=regular&&row&&outcomeReady(row)&&model.coefficients?projectOutcome(row,model.coefficients):null;
 const residual=actualMargin!==null&&expectedMargin!==null?actualMargin-expectedMargin:null;
 const reason=!regular?'regular_season_only':!row?'incomplete_or_mismatched_profiles':'insufficient_training_or_inputs';
 const penaltyTail=empiricalExpectationTail(penalty?.score??null,calibration[useRef?'ref':'base'],reason),outcomeTail=empiricalExpectationTail(residual===null?null:Math.abs(residual),calibration.outcome,reason);
 const teams=[false,true].map(home=>{const team=home?game.homeTeam:game.awayTeam,opponent=home?game.awayTeam:game.homeTeam,history=ref?.teams.get(expectationTeam(team))??blankTeamRef(),p=predicted?(home?predicted.home:predicted.away):null,n=row?(home?row.homePenalties:row.awayPenalties):null,yards=row?(home?row.homePenaltyYards:row.awayPenaltyYards):null;return {team,opponent,actual:{penalties:n,penaltyYards:yards},league:mean(model.league),teamHistory:mean(model.teams.get(expectationTeam(team))??blank()),opponentDrawn:mean(model.drawn.get(expectationTeam(opponent))??blank()),expected:regular?p:null,residual:regular&&p&&n!==null&&yards!==null?{penalties:n-p.penalties,penaltyYards:yards-p.penaltyYards}:null,refereeHistory:{...mean(history),wins:history.wins,losses:history.losses,ties:history.ties}};});
 return gameExpectationsSchema.parse({version:EXPECTATIONS_VERSION,gameId:game.id,homeTeam:game.homeTeam,awayTeam:game.awayTeam,status:penaltyTail.status==='supported'&&outcomeTail.status==='supported'?'supported':penaltyTail.status==='supported'||outcomeTail.status==='supported'?'limited':'unavailable',
  cutoff:{targetSeason:game.season,trainingSeasons:model.trainingSeasons,calibrationSeasons:years(game.season,3)},teams,
  referee:{name:attribution.name,canonicalId:id,status:attribution.status,reasonCode:attribution.status==='conflict'?'conflicting_referee_assignment':attribution.status==='missing'?'referee_missing':!effect?'insufficient_referee_history':null,games:ref?.games??0,meanTotalPenalties:mean(ref?.total??blank()).meanPenalties,meanTotalPenaltyYards:mean(ref?.total??blank()).meanPenaltyYards,home:mean(ref?.home??blank()),away:mean(ref?.away??blank()),effect},
  penalty:{...penaltyTail,method:penalty?(useRef?'team_opponent_referee':'team_opponent'):'unavailable',components:penalty?.components??[]},
  outcome:{...outcomeTail,method:'retrospective_box_score',actualHomeMargin:actualMargin,expectedHomeMargin:expectedMargin,residual,coefficients:model.coefficients,trainingGames:model.outcomeGames},
  reference:{version:reference.version,checksum:loaded.checksum,sourceUrls:reference.sourceUrls,sourceChecksums:reference.sourceChecksums},
  notes:['Expected penalties use prior-five-season team-committed and opponent-drawn averages shrunk toward the league with 20 games, combining equal deviations. Referee residual effects use a 40-game prior and at least 10 observed games; unavailable referee effects use a separately calibrated team/opponent baseline.',
   'The penalty family takes the maximum absolute standardized residual across total count, total yards, count imbalance, and yards imbalance; correlated components are not added. Imbalance is home minus away.',
   'Outcome expectation is retrospective: OLS uses final net-yard differential and turnover margin. It is not a pregame forecast, a win probability, or an attribution of who caused the outcome.',
   'Each calibration game is predicted using only its own preceding five seasons; tails use (at least as unusual + 1)/(calibration games + 1), requiring 500 calibration games. No current/future-season outcome enters fitting.',
   'Referee statistics describe games associated with the named head official, not a fixed crew or the person who threw each flag. Referee/team wins are context only. Overtime exposure, unrecorded fouls, and call correctness are not modeled.']});
}
