import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({publishing:vi.fn(),report:vi.fn(),status:vi.fn(),fetch:vi.fn()}));
vi.mock('@under-review/core/repository',()=>({getReport:mocks.report,getOperationalStatus:mocks.status}));
vi.mock('@under-review/core/publishing',()=>({getPublishingSettings:mocks.publishing}));
vi.mock('@under-review/core/config',()=>({config:{staging:false,livePostingAllowed:true}}));
import { checkSiteReadiness } from '../scripts/site-readiness.js';
describe('public and staging website readiness',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);mocks.fetch.mockImplementation(async()=>new Response('ready'));
  mocks.publishing.mockResolvedValue({mode:'automatic',killSwitch:false,accountId:'synthetic-account',activatedAt:'2026-09-23T00:00:00Z'});
  mocks.report.mockResolvedValue({revision:{number:2,analysis:{metrics:[{}]}},drafts:[]});mocks.status.mockResolvedValue({database:true});
 });
 afterEach(()=>vi.unstubAllGlobals());
 it('accepts authorized public automation while retaining all common route/report checks',async()=>{
  const result=await checkSiteReadiness({staging:false,origin:'https://example.invalid',games:['synthetic-game']});
  expect(result).toMatchObject({livePosting:true,status:{database:true},reports:[{gameId:'synthetic-game',revision:2,metrics:1,drafts:0}]});
  expect(result.routes.map(row=>row.route)).toEqual(['/','/methodology','/sources','/corrections','/status','/api/health','/api/ready','/robots.txt']);expect(mocks.fetch).toHaveBeenCalledTimes(8);
 });
 it.each([{mode:'automatic',killSwitch:false},{mode:'automatic',killSwitch:true},{mode:'draft-only',killSwitch:false}])('rejects staging publication state %j',async settings=>{
  mocks.publishing.mockResolvedValue(settings);await expect(checkSiteReadiness({staging:true,games:[]})).rejects.toThrow('Staging publication guard is not enabled');
 });
 it('accepts guarded staging',async()=>{
  mocks.publishing.mockResolvedValue({mode:'draft-only',killSwitch:true});expect((await checkSiteReadiness({staging:true,games:[]})).livePosting).toBe(false);
 });
 it.each([false,true])('still rejects a failed route in staging=%s',async staging=>{
  mocks.fetch.mockResolvedValueOnce(new Response(null,{status:503}));await expect(checkSiteReadiness({staging,games:[]})).rejects.toThrow('Route / returned 503');expect(mocks.publishing).not.toHaveBeenCalled();
 });
});
