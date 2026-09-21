import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { analyzeGame } from '@under-review/core/pipeline';
import { getReport } from '@under-review/core/repository';
import { query,pool } from '@under-review/core/db';
import { config,projectRoot,safeError } from '@under-review/core/config';
import { supportedFindings,draftPost } from '@under-review/core/summaries';

interface BenchmarkCase {gameId:string;group:string;label:string;target?:{quarter:number;maximumSecondsRemaining:number;pattern:string}}
const [caseFile,outputDirectory]=process.argv.slice(2);
if(!caseFile||!outputDirectory)throw new Error('Usage: controversy-benchmark.ts CASES_JSON OUTPUT_DIRECTORY');
if(process.env.VPS_STAGING==='true')throw new Error('Run historical benchmarks locally, not on the shared VPS.');
if(config.livePostingAllowed)throw new Error('Disable live posting before running this benchmark.');
const rawCases=await readFile(caseFile);
const cohort=JSON.parse(rawCases.toString()) as {design:string;cases:BenchmarkCase[]};
const startedAt=new Date().toISOString();
const hashes:Record<string,string>={};
for(const file of ['analytics/models/manifest.json','analytics/models/evaluation.json','analytics/models/category-reference.json','analytics/models/game-profiles.json']){
 hashes[file]=createHash('sha256').update(await readFile(path.join(projectRoot,file))).digest('hex');
}
const codeHashes:Record<string,string>={};
for(const file of ['packages/core/src/normalize.ts','packages/core/src/summaries.ts','packages/core/src/game-audit.ts','packages/core/src/game-profile-source.ts','packages/core/src/pipeline.ts','analytics/R/engine.R','scripts/controversy-benchmark.ts'])codeHashes[file]=createHash('sha256').update(await readFile(path.join(projectRoot,file))).digest('hex');
await mkdir(outputDirectory,{recursive:true});
const outcomes:Record<string,unknown>[]=[];
const save=()=>writeFile(path.join(outputDirectory,'results.json'),JSON.stringify({startedAt,updatedAt:new Date().toISOString(),sourceCommit:process.env.BENCHMARK_SOURCE_COMMIT??null,codeFileHashes:codeHashes,cohortChecksum:createHash('sha256').update(rawCases).digest('hex'),modelFileHashes:hashes,design:cohort.design,mode:'existing statistical models plus versioned game audit; clean source; backfill; no manual reviews; no social submissions',outcomes},null,2));
try{
 for(const entry of cohort.cases){
  const began=Date.now();console.log(JSON.stringify({event:'benchmark.started',gameId:entry.gameId}));
  try{
   const result=await analyzeGame(entry.gameId,{backfill:true,preferRaw:false});
   const report=await getReport(entry.gameId,result.number);if(!report)throw new Error('Analysis did not create a report.');
   const manual=(await query('SELECT count(*)::int AS count FROM events WHERE game_id=$1 AND manual=true',[entry.gameId])).rows[0].count;
   if(report.reviews.length||manual)throw new Error('This benchmark expects no manual candidates or reviews.');
   const analysis=report.revision.analysis;
   const plays=(await query('SELECT play_id,data FROM plays WHERE game_id=$1 AND snapshot_id=ANY($2::text[]) ORDER BY provider_order',[entry.gameId,report.revision.sourceSnapshots.map(s=>s.id)])).rows;
   const target=entry.target;
   const matchedPlays=target?plays.filter(p=>Number(p.data.qtr)===target.quarter&&p.data.quarter_seconds_remaining!==null&&p.data.quarter_seconds_remaining!==undefined&&p.data.quarter_seconds_remaining!==''&&Number.isFinite(Number(p.data.quarter_seconds_remaining))&&Number(p.data.quarter_seconds_remaining)<=target.maximumSecondsRemaining&&new RegExp(target.pattern,'i').test(String(p.data.desc??''))):[];
   const playIds=new Set(matchedPlays.map(p=>String(p.play_id)));
   const targetEvents=analysis.events.filter(e=>playIds.has(e.playId));
   const targetEventIds=new Set(targetEvents.map(e=>e.id));
   const targetMetrics=analysis.metrics.filter(m=>m.playIds.some(id=>playIds.has(id))||m.eventIds.some(id=>targetEventIds.has(id)));
   const impact=new Map<string,number>();
   for(const m of analysis.metrics)if(m.status==='supported'&&m.unit==='wp_delta'&&m.value!==null&&m.eventIds.length===1)impact.set(m.eventIds[0],Math.max(impact.get(m.eventIds[0])??0,Math.abs(m.value)));
   const orderedEvents=[...analysis.events].sort((a,b)=>(impact.get(b.id)??-1)-(impact.get(a.id)??-1));
   const findings=supportedFindings(analysis);
   const auditEvidence={gameAudit:analysis.gameAudit,targetReviewCandidates:analysis.gameAudit?.reviewCandidates.filter(c=>playIds.has(c.playId))??[],targetNeedsReview:analysis.gameAudit?.reviewCandidates.some(c=>playIds.has(c.playId))??false};
   const row={...entry,elapsedSeconds:(Date.now()-began)/1000,result,score:{away:report.game.awayTeam,awayScore:report.game.awayScore,home:report.game.homeTeam,homeScore:report.game.homeScore},revision:report.revision.number,inputHash:report.revision.inputHash,summary:report.revision.summary,reviewStatus:report.revision.reviewStatus,chartingStatus:report.revision.chartingStatus,metricCount:analysis.metrics.length,eventCount:analysis.events.length,coverage:analysis.coverage,metricStatusCounts:Object.fromEntries(['supported','experimental','unavailable'].map(s=>[s,analysis.metrics.filter(m=>m.status===s).length])),reasonCounts:analysis.metrics.reduce<Record<string,number>>((a,m)=>{if(m.reasonCode)a[m.reasonCode]=(a[m.reasonCode]??0)+1;return a;},{}),supportedFindings:findings,headlineMetrics:findings.slice(0,2),targetMatchedPlays:matchedPlays,targetTimeline:analysis.timeline.filter(p=>playIds.has(p.playId)),targetEvents:targetEvents.map(e=>({...e,eventRank:orderedEvents.findIndex(x=>x.id===e.id)+1,visibleInTop12:orderedEvents.findIndex(x=>x.id===e.id)<12})),targetMetrics,targetInHeadline:findings.slice(0,2).some(m=>m.playIds.some(id=>playIds.has(id))||m.eventIds.some(id=>targetEventIds.has(id))),supportedRarities:analysis.metrics.filter(m=>m.rarity?.status==='supported'),draftPreview:draftPost(report.game,analysis,`${config.siteUrl}/games/${entry.gameId}`,false,report.revision.reviewStatus),warnings:analysis.warnings};
   await writeFile(path.join(outputDirectory,entry.gameId+'.json'),JSON.stringify(report,null,2));
   outcomes.push({...row,...auditEvidence});console.log(JSON.stringify({event:'benchmark.completed',gameId:entry.gameId,elapsedSeconds:row.elapsedSeconds,metrics:row.metricCount,matchedTargetPlays:matchedPlays.length,auditStatus:analysis.gameAudit?.status,targetNeedsReview:auditEvidence.targetNeedsReview}));
  }catch(error){const row={...entry,error:safeError(error),elapsedSeconds:(Date.now()-began)/1000};outcomes.push(row);console.error(JSON.stringify({event:'benchmark.failed',...row}));process.exitCode=1;}
  await save();
 }
}finally{await pool.end();}
