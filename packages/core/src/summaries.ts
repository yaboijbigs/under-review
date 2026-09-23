import twitterText from 'twitter-text';
import type { AnalysisResult,Game,Metric } from './contracts.js';
import { getGameVerdict } from './consumer-summary.js';

export function metricDisplay(metric:Metric):string {
 if(metric.value===null)return 'Unavailable';
 if(metric.unit==='probability'||metric.unit==='wp'||metric.unit==='wp_delta')return `${(metric.value*100).toFixed(1)} percentage points`;
 return `${Number(metric.value.toFixed(2))} ${metric.unit}`;
}
export function supportedFindings(analysis:AnalysisResult):Metric[]{
 const eligible=analysis.metrics.filter(m=>m.status==='supported'&&m.value!==null&&Math.abs(m.value)>0.000001&&m.coverage.modeled>0&&m.eventIds.every(id=>analysis.events.some(e=>e.id===id))&&!m.assumptions.some(a=>/kickoff_assumption_sensitive/i.test(a)));
 // Compare like units. WP event consequences lead; descriptive count context follows.
 const priority=(m:Metric)=>m.unit==='wp_delta'?0:m.category==='kicking'?1:m.category==='fumble'?2:m.category==='execution'&&/drops|interception-worthy|attributed sacks/i.test(m.name)?3:4;
 eligible.sort((a,b)=>priority(a)-priority(b)||(a.unit===b.unit?Math.abs(b.value!)-Math.abs(a.value!):a.unit.localeCompare(b.unit))||a.id.localeCompare(b.id));
 const chosen:Metric[]=[];const events=new Set<string>();const categories=new Set<string>();
 for(const m of eligible){if(categories.has(m.category)||m.eventIds.some(id=>events.has(id)))continue;chosen.push(m);categories.add(m.category);m.eventIds.forEach(id=>events.add(id));}
 return chosen;
}
export function reportSummary(game:Game,analysis:AnalysisResult):string{
 const findings=supportedFindings(analysis).slice(0,2);
 const score=`${game.awayTeam} ${game.awayScore ?? '–'}, ${game.homeTeam} ${game.homeScore ?? '–'}.`;
 if(analysis.gameAudit?.version==='under-review-game-audit-v5'){const verdict=getGameVerdict(analysis.gameAudit);return `${score} ${verdict.label}${verdict.rating?` ${verdict.rating}/5`:''}. ${verdict.summary}`;}
 if(analysis.gameAudit)return `${score} ${analysis.gameAudit.headline} Officiating correctness: not reviewed.`;
 return `${score} ${findings.length?findings.map(m=>`${m.team?m.team+': ':''}${m.name}: ${metricDisplay(m)}.`).join(' '):'The final score is reconciled; supported category findings are still being processed.'} Officiating correctness: not reviewed.`;
}
export interface EvidenceDraft{text:string;evidenceIds:string[];weightedLength:number;valid:boolean}
export function draftPost(game:Game,analysis:AnalysisResult,url:string,preliminary:boolean,reviewStatus='not_reviewed',kind:'initial'|'correction'|'update'='initial'):EvidenceDraft{
 const prefix=`${kind==='initial'?'':kind==='correction'?'Correction: ':'Update: '}${game.awayTeam} ${game.awayScore}–${game.homeScore} ${game.homeTeam}.`;
 const findings=supportedFindings(analysis);
 const suffix=`${preliminary?' Preliminary.':''} ${reviewStatus==='not_reviewed'?'Calls not reviewed.':'Selected calls reviewed; limited scope.'} ${url}`;
 const audit=analysis.gameAudit;
 if(audit){
  const flag=audit.flags.find(f=>f.status==='historical_outlier'||f.status==='unusual_profile')??audit.flags.find(f=>f.status==='rare_sample');
  const comparison=flag?.reference;
  const detail=flag&&comparison?`${flag.team} won: ${flag.conditions.join('; ')}. ${comparison.matchingGames?`Prior: ${comparison.wins}W/${comparison.losses}L/${comparison.ties}T (${comparison.startSeason}–${comparison.endSeason}).`:'No comparable prior records available.'}`:audit.reviewCandidates.length?`${audit.reviewCandidates.length} plays queued for review.`:audit.headline;
  const attempts=[`${prefix} ${detail}${suffix}`,`${prefix} ${audit.headline}${suffix}`];
  const text=attempts.find(t=>twitterText.parseTweet(t).valid);
  if(text){const parsed=twitterText.parseTweet(text);return {text,evidenceIds:flag?[flag.id]:audit.reviewCandidates.map(c=>c.id),weightedLength:parsed.weightedLength,valid:parsed.valid};}
 }
 const selected:Metric[]=[];
 let text=prefix+suffix;
 for(const metric of findings){
  const trial=[...selected,metric].map(m=>`${m.team??''} ${m.name}: ${metricDisplay(m)}.`.trim()).join(' ');
  const candidate=`${prefix} ${trial}${suffix}`;
  if(twitterText.parseTweet(candidate).valid){selected.push(metric);text=candidate;}
  if(selected.length===2)break;
 }
 if(!selected.length)text=`${prefix} Evidence and coverage report available.${suffix}`;
 const parsed=twitterText.parseTweet(text);
 return {text,evidenceIds:selected.map(m=>m.id),weightedLength:parsed.weightedLength,valid:parsed.valid};
}
export function validateDraft(text:string,canonical:EvidenceDraft):boolean{
 // Exact template rendering is the evidence-constrained baseline. Free-form model text cannot bypass it.
 return text===canonical.text&&canonical.valid&&!/rigged|manipulat|fixed game|intentional misconduct/i.test(text);
}
