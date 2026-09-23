import type { Game, GameAudit, GameProfile, MarketAudit } from '../packages/core/src/contracts.js';

export function expectationsFixture({outcomeCount=200,penaltyCount=200,residual=-18.2}:{outcomeCount?:number;penaltyCount?:number;residual?:number}={}){
 const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:23,kickoffAt:null,providerData:{}};
 const home:GameProfile={gameId:game.id,season:2026,team:'NYJ',opponent:'GB',pointsFor:20,pointsAgainst:23,totalYards:350,opponentYards:199,penalties:4,penaltyYards:30,turnoverMargin:1,nonOffensiveTouchdowns:0};
 const away:GameProfile={...home,team:'GB',opponent:'NYJ',pointsFor:23,pointsAgainst:20,totalYards:199,opponentYards:350,penalties:13,penaltyYards:133,turnoverMargin:-1};
 const baseline={games:80,meanPenalties:6,meanPenaltyYards:50},empty={games:0,meanPenalties:null,meanPenaltyYards:null};
 const tail=(count:number,score:number)=>({status:'supported' as const,reasonCode:null,anomalyScore:score,tailProbability:(count+1)/806,calibrationGames:805,atLeastAsUnusual:count});
 const actual=[17,163,-9,-103],expected=[12,100,0,0],scale=[2,20,2,20];
 const components=(['total_count','total_yards','imbalance_count','imbalance_yards'] as const).map((id,i)=>({id,actual:actual[i],expected:expected[i],residual:actual[i]-expected[i],scale:scale[i],standardized:(actual[i]-expected[i])/scale[i]}));
 const source='https://example.invalid/synthetic-expectations.csv',expectedHomeMargin=-3-residual;
 const audit:GameAudit={version:'under-review-game-audit-v5',status:'no_flag_found',headline:'Synthetic fixture',profiles:[home,away],flags:[],reviewCandidates:[],context:[],reference:{version:'synthetic',checksum:'a'.repeat(64),startSeason:1999,endSeason:2025,teamGames:1000},notes:[],
  expectations:{version:'under-review-expectations-v1',gameId:game.id,homeTeam:'NYJ',awayTeam:'GB',status:'supported',cutoff:{targetSeason:2026,trainingSeasons:[2021,2022,2023,2024,2025],calibrationSeasons:[2023,2024,2025]},
   teams:[home,away].map(p=>({team:p.team,opponent:p.opponent,actual:{penalties:p.penalties,penaltyYards:p.penaltyYards},league:{...baseline,games:2000},teamHistory:{...baseline},opponentDrawn:{...baseline},expected:{penalties:6,penaltyYards:50},residual:{penalties:p.penalties!-6,penaltyYards:p.penaltyYards!-50},refereeHistory:{...empty,wins:0,losses:0,ties:0}})),
   referee:{name:null,canonicalId:null,status:'missing',reasonCode:'referee_missing',games:0,meanTotalPenalties:null,meanTotalPenaltyYards:null,home:{...empty},away:{...empty},effect:null},
   penalty:{...tail(penaltyCount,Math.max(...components.map(c=>Math.abs(c.standardized)))),method:'team_opponent',components},
   outcome:{...tail(outcomeCount,Math.abs(residual)),method:'retrospective_box_score',actualHomeMargin:-3,expectedHomeMargin,residual,coefficients:{intercept:expectedHomeMargin-5*1.51-4,yardsPer100:5,turnoverMargin:4},trainingGames:1000},
   reference:{version:'under-review-expectations-reference-v1',checksum:'c'.repeat(64),sourceUrls:[source],sourceChecksums:{[source]:'d'.repeat(64)}},notes:[]}};
 return {game,audit};
}

export function addExpectationCluster(audit:GameAudit,count:number,team='GB'){
 const opponent=team==='GB'?'NYJ':'GB',playIds=Array.from({length:count},(_,i)=>`19-${i}`);
 audit.context.push({kind:'drive_extending_penalties',team,playIds,text:'Synthetic penalty sequence'});
 audit.reviewCandidates.push(...playIds.map(playId=>({id:playId,playId,quarter:4,clock:'06:49',description:'Synthetic penalty',team,priority:'high' as const,observedWpSwing:null,existingEventId:null,reasons:[`Defensive penalty on ${opponent} awarded ${team} a first down on third down; call correctness requires review.`,`${count} defensive-penalty first downs on third or fourth down occurred on ${team} drive 19; review the sequence together.`]})));
}

export function expectationMarket(atLeastAsSurprising=0):MarketAudit{
 return {version:'under-review-spread-v1',status:'available',reasonCode:null,homeTeam:'NYJ',awayTeam:'GB',expectedHomeMargin:24,actualHomeMargin:-3,homeMarginError:-27,absoluteError:27,favoredTeam:'NYJ',pickem:false,atsWinner:'GB',atsResult:'away_covered',favoriteCovered:false,underdogWon:true,surprise:atLeastAsSurprising/805<=.05?'very_unusual':atLeastAsSurprising/805<=.1?'unusual':'ordinary',ratingFloor:atLeastAsSurprising/805<=.05?3:atLeastAsSurprising/805<=.1?2:1,
  source:{snapshotId:'synthetic',url:'https://example.invalid/synthetic-schedule',checksum:'a'.repeat(64),retrievedAt:'2026-09-23T00:00:00Z',field:'spread_line'},reference:{version:'synthetic',checksum:'b'.repeat(64),startSeason:2023,endSeason:2025,games:805,atLeastAsSurprising,tailRate:atLeastAsSurprising/805,percentile:100*(1-atLeastAsSurprising/805)},notes:[]};
}
