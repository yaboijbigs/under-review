import { describe,it,expect } from 'vitest';
import { classifyPostResponse,initialPublicationIneligibility,type PublishingSettings } from '../packages/core/src/publishing.js';
import { draftPost,validateDraft,supportedFindings,metricDisplay,reportSummary } from '../packages/core/src/summaries.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { readFile } from 'node:fs/promises';
import { normalizeSchedule,normalizeRow } from '../packages/core/src/normalize.js';
import { normalizeGameProfiles } from '../packages/core/src/game-profile-source.js';
import { gameAuditCorrection } from '../packages/core/src/repository.js';
import { validCsrf,trustedOrigin,type Session } from '../packages/core/src/auth.js';
import { safeError } from '../packages/core/src/config.js';
import { reviewInputSchema } from '../packages/core/src/reviews.js';
import { analysisSchema,type AnalysisResult,type Game } from '../packages/core/src/contracts.js';
const game:Game={id:'2026_01_NE_SEA',season:2026,week:1,gameType:'REG',homeTeam:'SEA',awayTeam:'NE',homeScore:13,awayScore:10,kickoffAt:null,providerData:{}};
const analysis:AnalysisResult={schemaVersion:1,metrics:[{id:'m1',category:'coaching',name:'Fourth-down decision cost',team:'NE',value:0.028,unit:'wp_delta',status:'supported',eventIds:['e1'],playIds:['10'],assumptions:[],modelVersion:'test',coverage:{eligible:1,modeled:1}}],events:[{id:'e1',playId:'10',quarter:4,clock:'02:00',description:'Synthetic test only',kind:'fourth_down',team:'NE',reviewStatus:'not_reviewed'}],timeline:[],coverage:[],models:[],warnings:[]};
describe('evidence-constrained drafting',()=>{
 it('converts fraction deltas to percentage points and keeps within weighted limits',()=>{const draft=draftPost(game,analysis,'https://example.com/a-very-long-report-link',true);expect(draft.valid).toBe(true);expect(draft.weightedLength).toBeLessThanOrEqual(280);expect(draft.text).toContain('2.8 percentage points');expect(draft.text).toContain('Preliminary');expect(draft.evidenceIds).toEqual(['m1']);});
 it('rejects invented numbers and free-form wording',()=>{const draft=draftPost(game,analysis,'https://example.com/game',false);expect(validateDraft(draft.text.replace('2.8','9.8'),draft)).toBe(false);expect(validateDraft(draft.text+' Rigged.',draft)).toBe(false);});
 it('excludes unsupported, broken-reference, and sensitive findings',()=>{const a=structuredClone(analysis);a.metrics[0].eventIds=['missing'];expect(supportedFindings(a)).toHaveLength(0);a.metrics[0].eventIds=['e1'];a.metrics[0].status='experimental';expect(supportedFindings(a)).toHaveLength(0);a.metrics[0].status='supported';a.metrics[0].assumptions=['kickoff_assumption_sensitive'];expect(supportedFindings(a)).toHaveLength(0);});
 it('does not turn missing into zero',()=>{const m={...analysis.metrics[0],value:null,status:'unavailable' as const};expect(metricDisplay(m)).toBe('Unavailable');});
 it('rejects nonfinite numeric and invalid WP timeline output',()=>{const a=structuredClone(analysis);a.metrics[0].value=Infinity;expect(analysisSchema.safeParse(a).success).toBe(false);a.metrics[0].value=0;a.timeline=[{playId:'10',quarter:1,clock:'10:00',homeWp:45,description:''}];expect(analysisSchema.safeParse(a).success).toBe(false);});
 it('leads with the computed historical finding and attributes counts to the correct conditions',async()=>{
  const fixture=JSON.parse(await readFile('analytics/models/game-profile-validation.json','utf8'));
  const reference=JSON.parse(await readFile('analytics/models/game-profiles.json','utf8'));
  const current=normalizeSchedule(normalizeRow(fixture.scheduleRows[0]));
  const profiles=normalizeGameProfiles(current,fixture.rawRows.map(normalizeRow));
  const result={...analysis,gameAudit:buildGameAudit({game:current,profiles,reference})};
  const draft=draftPost(current,result,'https://example.com/game',false);
  expect(reportSummary(current,result)).toContain('historical outlier');
  expect(draft.valid).toBe(true);expect(draft.text).toContain('6W/408L/0T (1999–2025)');
  expect(draft.text).toContain('Total offense below 200 yards; Negative turnover margin');
  expect(draft.text).not.toContain('100 penalty yards');
  expect(draft.evidenceIds).toEqual([`${current.id}:GB:low_offense_turnovers`]);
  expect(validateDraft(draft.text.replace('6W','0W'),draft)).toBe(false);
  const audit=result.gameAudit;
  expect(gameAuditCorrection(undefined,audit)).toBe(false);
  expect(gameAuditCorrection(audit,structuredClone(audit))).toBe(false);
  const changed=structuredClone(audit);changed.profiles[0].penaltyYards=0;
  expect(gameAuditCorrection(audit,changed)).toBe(true);
  const withdrawn=structuredClone(audit);withdrawn.flags=[];
  expect(gameAuditCorrection(audit,withdrawn)).toBe(true);
  const reviewOnly=structuredClone(audit);reviewOnly.notes.push('More context');
  expect(gameAuditCorrection(audit,reviewOnly)).toBe(false);
 });
});
describe('safe external delivery classification',()=>{
 it('only marks confirmed IDs as published',()=>{expect(classifyPostResponse(201,true)).toBe('published');expect(classifyPostResponse(201,false)).toBe('unknown_outcome');});
 it('does not blindly retry ambiguous responses',()=>{expect(classifyPostResponse(503,false)).toBe('unknown_outcome');expect(classifyPostResponse(408,false)).toBe('unknown_outcome');expect(classifyPostResponse(429,false)).toBe('retry');expect(classifyPostResponse(403,false)).toBe('failed');});
});
describe('upcoming-game publication cutoff',()=>{
 const settings:PublishingSettings={mode:'automatic',killSwitch:false,accountId:'1',activatedAt:'2026-09-23T00:00:00Z'};
 const eligible={publication_eligible:true,kickoff_at:'2026-09-24T00:00:00Z',first_validated_at:'2026-09-24T04:00:00Z'};
 it('requires an eligible future kickoff and a final validation after activation',()=>{
  expect(initialPublicationIneligibility(eligible,settings)).toBeNull();
  for(const changes of [{publication_eligible:false},{kickoff_at:null},{kickoff_at:'bad'},{kickoff_at:'2026-09-22T23:59:59Z'},{first_validated_at:null},{first_validated_at:'bad'},{first_validated_at:'2026-09-22T23:59:59Z'}])expect(initialPublicationIneligibility({...eligible,...changes},settings)).toBeTypeOf('string');
  expect(initialPublicationIneligibility(eligible,{...settings,activatedAt:null})).toBeTypeOf('string');
  expect(initialPublicationIneligibility(undefined,settings)).toBeTypeOf('string');
 });
});
describe('mutation security',()=>{
 const session:Session={id:'id',userId:'user',username:'operator',role:'admin',csrfToken:'random-secret-csrf',expiresAt:new Date().toISOString()};
 it('rejects missing and altered CSRF tokens',()=>{expect(validCsrf(session,session.csrfToken)).toBe(true);expect(validCsrf(session,'x')).toBe(false);expect(validCsrf(session,null)).toBe(false);});
 it('does not accept cross-origin requests',()=>{expect(trustedOrigin('https://attacker.example')).toBe(false);expect(trustedOrigin(null)).toBe(false);});
 it('requires substantive review evidence and safe links',()=>{expect(reviewInputSchema.safeParse({gameId:game.id,eventId:'e1',status:'likely_incorrect',ruleSeason:2026,ruleReference:'Rule 8',evidenceUrl:'javascript:alert(1)',rationale:'unsupported',confidence:'high',scope:'only this play'}).success).toBe(false);});
 it('redacts connection strings and named secrets',()=>{const result=safeError(new Error('password=abc token=def postgresql://user:pw@host/db'));expect(result).not.toContain('abc');expect(result).not.toContain('def');expect(result).not.toContain('user:pw');});
});
