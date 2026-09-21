import { config,projectRoot } from './config.js';
import path from 'node:path';
import { query } from './db.js';
import { LocalSnapshotStore,syncSchedule,ingestGame } from './ingest.js';
import { runAnalytics } from './analytics-bridge.js';
import { getGame,saveGames,saveSnapshots,saveAnalysis } from './repository.js';
import { enqueue } from './jobs.js';
import { maybeAutomaticDraft } from './publishing.js';

const store=()=>new LocalSnapshotStore(path.join(config.dataDir,'snapshots'));
export async function syncSeason(season:number,scheduleJobs=true){
 const result=await syncSchedule(season,store());await saveSnapshots(result.snapshots);
 for(const game of result.games)await saveGames([game],!!game.kickoffAt&&new Date(game.kickoffAt).getTime()>Date.now());
 if(scheduleJobs){
  const now=Date.now();
  for(const game of result.games){
   if(game.homeScore===null||game.awayScore===null)continue;
   const kickoff=game.kickoffAt?new Date(game.kickoffAt).getTime():0;
   if(kickoff&&now-kickoff<0)continue;
   if(kickoff&&now-kickoff>8*86400000)continue;
   const latest=(await query('SELECT created_at FROM analysis_revisions WHERE game_id=$1 ORDER BY number DESC LIMIT 1',[game.id])).rows[0];
   const bucket=Math.floor(now/(latest?6*3600000:15*60000));
   await enqueue('analyze',game.id,{backfill:false,preferRaw:!latest},`scheduled-analysis:${game.id}:${latest?'reconcile':'initial'}:${bucket}`);
  }
 }
 return {games:result.games.length,snapshots:result.snapshots.map(s=>s.id)};
}
export async function analyzeGame(gameId:string,{backfill=false,preferRaw=true}:{backfill?:boolean;preferRaw?:boolean}={}){
 const schedule=await syncSchedule(Number(gameId.slice(0,4)),store());
 await saveSnapshots(schedule.snapshots);
 const game=schedule.games.find(g=>g.id===gameId);
 if(!game)throw new Error('Game is not in the provider schedule.');
 await saveGames([game]);
 if(backfill)await query('UPDATE games SET publication_eligible=false WHERE id=$1',[gameId]);
 const ingested=await ingestGame(game,store(),{preferRaw,analytics:{scriptPath:path.join(projectRoot,'analytics/run.R'),timeoutMs:config.analyticsTimeoutMs}});
 await saveSnapshots(ingested.snapshots);
 if(!ingested.validation.valid)throw new Error('Game awaits complete final data: '+ingested.validation.issues.join(', '));
 const snapshots=[...schedule.snapshots,...ingested.snapshots];
 const analysis=await runAnalytics({schemaVersion:1,action:'analyze',game,plays:ingested.plays,ftn:ingested.ftn,snapshots,config:{closeCallTolerance:config.closeCallTolerance,modelDirectory:process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),chartingCoverage:ingested.chartingCoverage}},{scriptPath:path.join(projectRoot,'analytics/run.R'),timeoutMs:config.analyticsTimeoutMs});
 analysis.warnings=[...new Set([...analysis.warnings,...ingested.warnings])];
 const revision=await saveAnalysis(game,ingested.plays,snapshots,analysis,ingested.sourceKind);
 if(revision.created&&!backfill){
  await maybeAutomaticDraft(gameId);
  if(revision.number===1)for(const hours of [6,24,48])await enqueue('analyze',gameId,{backfill:false,preferRaw:false},`reconcile:${gameId}:initial:${hours}`,new Date(Date.now()+hours*3600000));
 }
 return {gameId,...revision,metrics:analysis.metrics.length,sourceKind:ingested.sourceKind,warnings:analysis.warnings};
}
