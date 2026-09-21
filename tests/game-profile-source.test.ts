import { describe,it,expect } from 'vitest';
import { normalizeGameProfiles,ingestGameProfiles,loadGameProfileReference } from '../packages/core/src/game-profile-source.js';
import type { Game } from '../packages/core/src/contracts.js';
import type { SnapshotStore } from '../packages/core/src/sources.js';
import { parseCsv,type ProviderRow } from '../packages/core/src/normalize.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,homeTeam:'NYJ',awayTeam:'GB',homeScore:17,awayScore:20,gameType:'REG',kickoffAt:null,providerData:{}};
const rows=[{game_id:game.id,season:2026,week:2,team:'GB',opponent_team:'NYJ',passing_yards:180,rushing_yards:44,sack_yards_lost:-25,passing_interceptions:0,fumbles_lost_total:1,penalties:14,penalty_yards:133,def_tds:0,special_teams_tds:0,fumble_recovery_tds:0},{game_id:game.id,season:2026,week:2,team:'NYJ',opponent_team:'GB',passing_yards:200,rushing_yards:115,sack_yards_lost:-30,passing_interceptions:0,fumbles_lost_total:0,penalties:13,penalty_yards:156,def_tds:0,special_teams_tds:0,fumble_recovery_tds:0}];
const official=JSON.parse(readFileSync(path.resolve('analytics/models/game-profile-validation.json'),'utf8')) as {rawRows:ProviderRow[]};
// These compact synthetic PBP rows exercise the gate with the independently verified
// gamebook subtotals. The full cached real PBP is additionally checked in integration.
const finalPbp:ProviderRow[]=[
 ...[['GB',145,-9,64],['NYJ',247,-29,68]].flatMap(([posteam,passing,sack,rushing])=>[
  {game_id:game.id,posteam,play_type:'pass',yards_gained:passing},
  {game_id:game.id,posteam,play_type:'pass',sack:1,yards_gained:sack},
  {game_id:game.id,posteam,play_type:'run',yards_gained:rushing},
  {game_id:game.id,posteam,play_type:'qb_kneel',yards_gained:-1},
  {game_id:game.id,posteam,play_type:'qb_spike',yards_gained:0},
 ]),
 {game_id:game.id,posteam:'GB',play_type:'no_play',yards_gained:99},
 {game_id:game.id,posteam:'GB',play_type:'run',two_point_attempt:1,yards_gained:2},
 {game_id:game.id,posteam:'GB',play_type:'run',extra_point_attempt:1,yards_gained:1},
 {game_id:game.id,play_type:'no_play',desc:'END GAME'},
];
function source(input:ProviderRow[]):SnapshotStore{
 const headers=Object.keys(input[0]);
 const cell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
 const csv=[headers.join(','),...input.map(row=>headers.map(key=>cell(row[key])).join(','))].join('\n');
 return {fetch:async()=>({id:'aggregate-fixture',provider:'nflverse-team-stats',url:'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2026.csv',retrievedAt:'2026-09-21T00:00:00Z',checksum:'fixture',path:'/fixture.csv',license:'CC-BY-4.0',metadata:{}}),read:async()=>Buffer.from(csv)};
}
describe('official team aggregate adapter',()=>{
 it('adds signed sack yards and computes symmetric turnover margins from all units',()=>{
  const [away,home]=normalizeGameProfiles(game,rows);
  expect(away).toMatchObject({totalYards:199,opponentYards:285,penaltyYards:133,turnoverMargin:-1,pointsFor:20,nonOffensiveTouchdowns:0});
  expect(home).toMatchObject({totalYards:285,turnoverMargin:1,penaltyYards:156});
 });
 it('preserves missing values instead of turning them into zero',()=>{
  const [away,home]=normalizeGameProfiles(game,[{...rows[0],sack_yards_lost:null,penalty_yards:null,fumbles_lost_total:null},rows[1]]);
  expect(away.totalYards).toBeNull();expect(away.penaltyYards).toBeNull();expect(away.turnoverMargin).toBeNull();expect(home.turnoverMargin).toBeNull();expect(home.opponentYards).toBeNull();
 });
 it('rejects incomplete, duplicate and mismatched pairs',()=>{
  for(const invalid of [rows.slice(0,1),[...rows,rows[0]],[rows[0],rows[0]],[rows[0],{...rows[1],opponent_team:'CHI'}],[rows[0],{...rows[1],week:3}]])expect(()=>normalizeGameProfiles(game,invalid)).toThrow();
 });
 it('resolves franchise aliases while preserving the historical schedule identity',()=>{
  const old={...game,id:'2010_02_OAK_SD',season:2010,awayTeam:'OAK',homeTeam:'SD'};
  const input=rows.map((r,i)=>({...r,game_id:old.id,season:2010,team:i?'LAC':'LV',opponent_team:i?'LV':'LAC'}));
  expect(normalizeGameProfiles(old,input).map(p=>p.team)).toEqual(['OAK','SD']);
 });
 it('keeps game analysis available when the optional aggregate release is unavailable',async()=>{
  const result=await ingestGameProfiles(game,{fetch:async()=>{throw new Error('network unavailable');},read:async()=>Buffer.alloc(0)});
  expect(result.profiles).toEqual([]);expect(result.warnings[0]).toContain('team_stats_unavailable');
 });
 it('accepts authentic GB–NYJ aggregates when score and net yards both reconcile',async()=>{
  const result=await ingestGameProfiles(game,source(official.rawRows),finalPbp);
  expect(result.warnings).toEqual([]);expect(result.profiles).toHaveLength(2);
  expect(result.profiles[0]).toMatchObject({team:'GB',pointsFor:20,totalYards:199,penaltyYards:133,turnoverMargin:-1});
 });
 it('rejects stale paired aggregates whose scoring does not match the final game',async()=>{
  const stale=structuredClone(official.rawRows);stale[0].passing_tds='1';
  const result=await ingestGameProfiles(game,source(stale),finalPbp);
  expect(result.profiles).toEqual([]);expect(result.snapshots).toHaveLength(1);
  expect(result.warnings[0]).toContain('team_stats_score_mismatch');
 });
 it('withholds the real 2022 Super Bowl aggregate with an unclassified fumble touchdown',async()=>{
  const reference=JSON.parse(readFileSync(path.resolve('analytics/models/game-profiles.json'),'utf8'));
  const snapshot=reference.sources.find((s:{url:string})=>s.url.endsWith('_2022.csv'));
  const input=parseCsv(gunzipSync(readFileSync(path.resolve('analytics/models/game-profile-sources',snapshot.archive))));
  const superBowl={...game,id:'2022_22_KC_PHI',season:2022,week:22,awayTeam:'KC',homeTeam:'PHI',awayScore:38,homeScore:35};
  const pair=input.filter(row=>row.game_id===superBowl.id);
  expect(pair.find(row=>row.team==='KC')).toMatchObject({def_tds:0,special_teams_tds:0,fumble_recovery_tds:1});
  expect(normalizeGameProfiles(superBowl,pair).find(row=>row.team==='KC')?.nonOffensiveTouchdowns).toBeNull();
  const result=await ingestGameProfiles(superBowl,source(pair),[]);
  expect(result.profiles).toEqual([]);expect(result.warnings[0]).toContain('team_stats_score_mismatch');
 });
 it('withholds non-offensive touchdown context for ambiguous or unknown fumble recovery touchdowns',()=>{
  for(const value of [1,2,null]){
   const input=[{...rows[0],fumble_recovery_tds:value},rows[1]];
   expect(normalizeGameProfiles(game,input)[0].nonOffensiveTouchdowns).toBeNull();
  }
 });
 it('rejects stale yards even when the aggregate score already matches the final score',async()=>{
  const stale=structuredClone(official.rawRows);stale[0].passing_yards='135';
  const result=await ingestGameProfiles(game,source(stale),finalPbp);
  expect(result.profiles).toEqual([]);expect(result.warnings[0]).toContain('team_stats_yards_mismatch');
 });
 it('does not interpret missing scoring components as zero',async()=>{
  const missing=structuredClone(official.rawRows);missing[0].def_2pt_made='';
  const result=await ingestGameProfiles(game,source(missing),finalPbp);
  expect(result.profiles).toEqual([]);expect(result.warnings[0]).toContain('team_stats_scoring_incomplete');
 });
 it('does not double count receiving touchdowns or receiving two-point conversions',async()=>{
  const input=structuredClone(official.rawRows);input[0].receiving_tds='2';input[0].receiving_2pt_conversions='1';
  input[0].passing_2pt_conversions='1';input[0].pat_made='0';
  const result=await ingestGameProfiles(game,source(input),finalPbp);
  expect(result.profiles).toHaveLength(2);expect(result.warnings).toEqual([]);
 });
 it('withholds profiles when final PBP or counted scrimmage yards cannot be checked',async()=>{
  const absent=await ingestGameProfiles(game,source(official.rawRows));
  expect(absent.profiles).toEqual([]);expect(absent.warnings[0]).toContain('team_stats_final_pbp_unavailable');
  const missing=structuredClone(finalPbp);missing[0].yards_gained=null;
  const incomplete=await ingestGameProfiles(game,source(official.rawRows),missing);
  expect(incomplete.profiles).toEqual([]);expect(incomplete.warnings[0]).toContain('team_stats_pbp_yards_incomplete');
 });
 it('loads a validated, checksummed reproducible reference without target-season leakage',async()=>{
  const result=await loadGameProfileReference(path.resolve('analytics/models/game-profiles.json'));
  expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);expect(result.reference.rows.length).toBeGreaterThan(14000);
  expect(Math.max(...result.reference.rows.map(r=>r.season))).toBe(2025);
 });
});
