import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../packages/core/src/db.js',()=>({query:mocks.query}));
import { config } from '../packages/core/src/config.js';
import { createFeedbackToken,feedbackVisitorId,feedbackCookie,feedbackClientKey,parseFeedbackSubmission,saveVisitorFeedback,getVisitorFeedback,getFeedbackSummary,listVisitorFeedback } from '../packages/core/src/visitor-feedback.js';
import { SUSPICION_RULES_VERSION } from '../packages/core/src/consumer-summary.js';
import type { GameAudit,GameProfile } from '../packages/core/src/contracts.js';

const previousSecret=config.sessionSecret,previousUrl=config.siteUrl;
const revisionId='c1111111-1111-4111-8111-111111111111',visitorId='a'.repeat(64);
const profile:GameProfile={gameId:'2026_01_GB_MIN',season:2026,team:'GB',opponent:'MIN',pointsFor:21,pointsAgainst:17,totalYards:350,opponentYards:300,penalties:4,penaltyYards:30,turnoverMargin:1,nonOffensiveTouchdowns:0};
const audit:GameAudit={version:'test',status:'no_flag_found',headline:'Test',profiles:[profile,{...profile,team:'MIN',opponent:'GB',pointsFor:17,pointsAgainst:21,totalYards:300,opponentYards:350,turnoverMargin:-1}],flags:[],reviewCandidates:[],context:[],reference:{version:'test',checksum:'a'.repeat(64),startSeason:1999,endSeason:2025,teamGames:2000},notes:[]};
const submission={revisionId,rulesVersion:SUSPICION_RULES_VERSION,agreement:'agree',rating:1,modelRating:1,comment:' My view. '};
const row={agreement:'agree',rating:1,comment:'My view.',updated_at:new Date('2026-09-23T00:00:00Z')};

describe('private visitor feedback',()=>{
 beforeEach(()=>{mocks.query.mockReset();config.sessionSecret='feedback-tests-only-'.repeat(3);config.siteUrl='https://underreview.example';vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','false');});
 afterEach(()=>{config.sessionSecret=previousSecret;config.siteUrl=previousUrl;vi.unstubAllEnvs();});
 it('uses distinct signed browser tokens and stores only their hashes',()=>{
  const a=createFeedbackToken(),b=createFeedbackToken();expect(a).not.toBe(b);expect(feedbackVisitorId(a)).toMatch(/^[a-f0-9]{64}$/);expect(feedbackVisitorId(a)).toBe(feedbackVisitorId(a));expect(feedbackVisitorId(a)).not.toBe(feedbackVisitorId(b));
  expect(feedbackVisitorId(a.slice(0,-1)+(a.endsWith('a')?'b':'a'))).toBeNull();expect(feedbackVisitorId('arbitrary')).toBeNull();expect(feedbackVisitorId(undefined)).toBeNull();
  expect(feedbackCookie(a)).toContain('HttpOnly; SameSite=Lax');expect(feedbackCookie(a)).toContain('; Secure');
 });
 it('fails closed without a signing secret',()=>{config.sessionSecret='';expect(()=>createFeedbackToken()).toThrow('unavailable');});
 it('does not trust spoofed client-address headers by default',()=>{
  const request=(ip:string)=>new Request('https://underreview.example',{headers:{'cf-connecting-ip':ip,'x-forwarded-for':ip}});
  expect(feedbackClientKey(request('203.0.113.1'))).toBe(feedbackClientKey(request('203.0.113.2')));
  vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','true');const key=feedbackClientKey(request('203.0.113.1'));expect(key).not.toContain('203.0.113.1');expect(key).not.toBe(feedbackClientKey(request('203.0.113.2')));expect(feedbackClientKey(request('2001:0DB8:0:0:0:0:0:1'))).toBe(feedbackClientKey(request('2001:db8::1')));
 });
 it.each([{rating:0},{rating:6},{rating:2.5},{rating:'4'},{agreement:'maybe'},{comment:'x'.repeat(1001)},{comment:'bad\u0000text'},{revisionId:'not-a-uuid'},{rulesVersion:'future-v99'},{visitorId:'injected'},{modelRating:null}])('rejects invalid input %j',change=>expect(()=>parseFeedbackSubmission({...submission,...change})).toThrow());
 it('stores explanations as text without treating their markup as trusted HTML',()=>expect(parseFeedbackSubmission({...submission,comment:' <script>alert(1)</script>\r\nMy view. '}).comment).toBe('<script>alert(1)</script>\nMy view.'));
 it('binds the submitted rating to the actual immutable report and upserts one visitor response',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{audit}]}).mockResolvedValueOnce({rows:[row]});
  expect(await saveVisitorFeedback(profile.gameId,visitorId,submission)).toEqual({agreement:'agree',rating:1,comment:'My view.',updatedAt:'2026-09-23T00:00:00.000Z'});
  expect(mocks.query.mock.calls[0][1]).toEqual([revisionId,profile.gameId]);
  expect(mocks.query.mock.calls[1][0]).toContain('ON CONFLICT(game_id,revision_id,rules_version,visitor_id) DO UPDATE');
  expect(mocks.query.mock.calls[1][1].slice(1)).toEqual([profile.gameId,revisionId,SUSPICION_RULES_VERSION,visitorId,'agree',1,1,'My view.']);
 });
 it('rejects stale displayed ratings and missing or unrated reports before inserting',async()=>{
  mocks.query.mockResolvedValue({rows:[{audit}]});await expect(saveVisitorFeedback(profile.gameId,visitorId,{...submission,modelRating:4})).rejects.toMatchObject({status:409});expect(mocks.query).toHaveBeenCalledTimes(1);
  mocks.query.mockResolvedValue({rows:[]});await expect(saveVisitorFeedback(profile.gameId,visitorId,submission)).rejects.toMatchObject({status:404});
  mocks.query.mockResolvedValue({rows:[{audit:null}]});await expect(saveVisitorFeedback(profile.gameId,visitorId,submission)).rejects.toMatchObject({status:409});
 });
 it('reads only the signed visitor’s own version-bound response',async()=>{mocks.query.mockResolvedValue({rows:[row]});await getVisitorFeedback(profile.gameId,revisionId,SUSPICION_RULES_VERSION,visitorId);expect(mocks.query.mock.calls[0][1]).toEqual([profile.gameId,revisionId,SUSPICION_RULES_VERSION,visitorId]);});
 it('returns aggregates without explanations or visitor identifiers',async()=>{
  mocks.query.mockResolvedValue({rows:[{agreement:'agree',rating:1,count:2},{agreement:'disagree',rating:4,count:3}]});
  expect(await getFeedbackSummary(profile.gameId,revisionId,SUSPICION_RULES_VERSION)).toEqual({total:5,agree:2,disagree:3,ratings:[{rating:1,count:2},{rating:2,count:0},{rating:3,count:0},{rating:4,count:3},{rating:5,count:0}]});
 });
 it('bounds the operator listing and omits visitor identifiers',async()=>{mocks.query.mockResolvedValue({rows:[{...row,id:revisionId,game_id:profile.gameId,revision_id:revisionId,number:3,model_rating:1,rules_version:SUSPICION_RULES_VERSION,visitor_id:visitorId}]});const result=await listVisitorFeedback(999);expect(mocks.query.mock.calls[0][1]).toEqual([100]);expect(result[0]).not.toHaveProperty('visitorId');expect(result[0]).not.toHaveProperty('visitor_id');});
});
