import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),approve:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'synthetic-session'})})}));
vi.mock('@under-review/core/auth',()=>({getSession:mocks.session,trustedOrigin:(origin:string|null)=>origin==='https://underreview.example',validCsrf:(_session:unknown,csrf:unknown)=>csrf==='synthetic-csrf',consumeRateLimit:async()=>true}));
vi.mock('@under-review/core/config',()=>({config:{siteUrl:'https://underreview.example'},safeError:(error:Error)=>error.message}));
vi.mock('@under-review/core/db',()=>({query:vi.fn(),audit:vi.fn()}));
vi.mock('@under-review/core/jobs',()=>({enqueue:vi.fn()}));
vi.mock('@under-review/core/publishing',()=>({approveDraft:mocks.approve,createDraft:vi.fn(),setPublishing:vi.fn(),setKillSwitch:vi.fn(),beginXConnection:vi.fn(),reconcilePublication:vi.fn()}));
vi.mock('@under-review/core/reviews',()=>({saveReview:vi.fn(),approveReview:vi.fn(),insertMissedEvent:vi.fn()}));
// Load the Next route at runtime; the root NodeNext check does not resolve Next's
// extensionless subpath types (the web workspace checks the route separately).
const routePath='../apps/web/app/api/admin/action/route.js';
const {POST}=await import(routePath) as {POST:(request:Request)=>Promise<Response>};
const request=(fields:Record<string,string>={},origin='https://underreview.example')=>new Request('https://underreview.example/api/admin/action',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({action:'approve-historical-draft',csrf:'synthetic-csrf',outboxId:'synthetic-draft',...fields})});
describe('explicit historical initial-post authorization route',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({userId:'synthetic-admin',role:'admin'});mocks.approve.mockResolvedValue('synthetic-live-row');});
 it.each(['','true','no'])('rejects missing or incorrect confirmation %s',async confirmHistoricalInitial=>{
  const response=await POST(request({confirmHistoricalInitial}));expect(response.status).toBe(303);expect(new URL(response.headers.get('location')!).searchParams.get('error')).toContain('Explicit confirmation');expect(mocks.approve).not.toHaveBeenCalled();
 });
 it('passes the exception only through the explicitly confirmed administrator action',async()=>{
  expect((await POST(request({confirmHistoricalInitial:'yes'}))).status).toBe(303);expect(mocks.approve).toHaveBeenCalledExactlyOnceWith('synthetic-draft','synthetic-admin',{authorizeHistoricalInitial:true});
 });
 it('does not grant an exception from an extra checkbox on ordinary approval',async()=>{
  await POST(request({action:'approve-draft',confirmHistoricalInitial:'yes'}));expect(mocks.approve).toHaveBeenCalledExactlyOnceWith('synthetic-draft','synthetic-admin');
 });
 it('retains administrator, origin and CSRF requirements',async()=>{
  expect((await POST(request({confirmHistoricalInitial:'yes'},'https://attacker.example'))).status).toBe(403);
  expect((await POST(request({confirmHistoricalInitial:'yes',csrf:'bad'}))).status).toBe(403);
  mocks.session.mockResolvedValue({userId:'synthetic-reviewer',role:'reviewer'});expect((await POST(request({confirmHistoricalInitial:'yes'}))).status).toBe(403);expect(mocks.approve).not.toHaveBeenCalled();
 });
});
