import {describe,it,expect} from 'vitest';
import {fitFrequencyModel,predictPenalty,penaltyOpportunities,type FrequencyGame} from '../packages/core/src/officiating-frequency.js';
import type {OfficiatingOpportunity,OfficiatingGameObservation} from '../packages/core/src/officiating-observations.js';
function opportunity(kind:'pass'|'run'|'unknown'='pass'):OfficiatingOpportunity{return {playId:'1',order:0,driveId:'1',state:{possessionTeam:'GB',defenseTeam:'MIN',quarter:1,down:3,yardsToGo:8,yardline100:60,halfSecondsRemaining:900,gameSecondsRemaining:2700,scoreDifference:0,possessionTimeouts:3,defenseTimeouts:3,receivesSecondHalfKickoff:1},playKind:kind,penalty:null,penaltyStatus:'none',penaltyExclusionReason:null,observedHomeWpChange:null,labels:{nextScore:null,homeWin:null}};}
function game(season:number,index:number):FrequencyGame{
 const o=opportunity(index%2?'run':'pass');if(index%20===0){o.penaltyStatus='accepted';o.penalty={team:'GB',type:'False Start',family:'offensive_presnap',yards:5,firstDownExtension:false,actualState:null,alternativeState:null,valuationReason:'test',assumption:null};o.playKind='unknown';}
 return {observation:{schemaVersion:1,gameId:`${season}_${index}`,season,week:1,gameType:'REG',homeTeam:'GB',awayTeam:'MIN',opportunities:[o],coverage:{} as OfficiatingGameObservation['coverage']},crew:[]};
}
const training=Array.from({length:500},(_,i)=>game(2020,i));
describe('conditional called-penalty expectations',()=>{
 it('never learns from target/future seasons even when they are passed in',()=>{
  const model=fitFrequencyModel(2021,training);expect(fitFrequencyModel(2021,[...training,...training.map(g=>({...g,observation:{...g.observation,season:2021}})),game(2030,0)])).toEqual(model);
  expect(model.trainingSeasons).toEqual([2020]);
 });
 it('counts only pass opportunities for defensive pass fouls',()=>{
  expect(penaltyOpportunities(opportunity('pass'),'GB').some(p=>p.family==='defensive_pass')).toBe(true);
  expect(penaltyOpportunities(opportunity('run'),'GB').some(p=>p.family==='defensive_pass')).toBe(false);
  expect(penaltyOpportunities(opportunity('unknown'),'GB').map(p=>p.family)).toEqual(['offensive_presnap','defensive_presnap']);
 });
 it('does not leak a presnap whistle through the unknown play-kind marker',()=>{
  const model=fitFrequencyModel(2021,training),a=opportunity('pass'),b=opportunity('unknown');
  const p=penaltyOpportunities(a,'GB').find(p=>p.family==='offensive_presnap')!,q=penaltyOpportunities(b,'GB').find(p=>p.family==='offensive_presnap')!;
  expect(predictPenalty(model,a,p)).toBe(predictPenalty(model,b,q));
 });
 it('does not turn excluded/ambiguous penalties into clean negative observations',()=>{
  const o=opportunity();o.penaltyStatus='excluded';expect(penaltyOpportunities(o,'GB')).toEqual([]);
 });
 it('withholds missing states and overtime rather than inventing no-penalty evidence',()=>{
  const o=opportunity();o.state.scoreDifference=null;expect(penaltyOpportunities(o,'GB')).toEqual([]);
  const ot=opportunity();ot.state.quarter=5;expect(penaltyOpportunities(ot,'GB')).toEqual([]);
 });
 it('uses a stable contextual fallback without enough verified crew roles',()=>{
  const model=fitFrequencyModel(2021,training),o=opportunity(),p=penaltyOpportunities(o,'GB')[0];
  expect(predictPenalty(model,o,p,'crew',[{role:'Referee',name:'Unknown'}])).toBe(predictPenalty(model,o,p,'context'));
 });
});
