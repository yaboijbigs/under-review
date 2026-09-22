import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

const auth=vi.hoisted(()=>({login:vi.fn(),sessionCookie:vi.fn(),trustedOrigin:vi.fn()}));
vi.mock('@under-review/core/auth',()=>auth);
vi.mock('@under-review/core/config',()=>({config:{siteUrl:'https://underreview.example'}}));
import { POST } from '../apps/web/app/api/auth/login/route.js';

async function clientKey(ip?:string,forwardedFor?:string):Promise<string>{
 const headers=new Headers({'origin':'https://underreview.example','content-type':'application/x-www-form-urlencoded'});
 if(ip!==undefined)headers.set('cf-connecting-ip',ip);
 if(forwardedFor!==undefined)headers.set('x-forwarded-for',forwardedFor);
 const response=await POST(new Request('https://underreview.example/api/auth/login',{method:'POST',headers,body:'username=operator&password=test-only'}));
 expect(response.status).toBe(303);
 return auth.login.mock.lastCall![2] as string;
}

describe('login client rate-limit identity',()=>{
 beforeEach(()=>{vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','');auth.login.mockReset().mockResolvedValue(null);auth.trustedOrigin.mockReset().mockReturnValue(true);});
 afterEach(()=>vi.unstubAllEnvs());
 it('ignores spoofed IP headers unless explicitly enabled',async()=>{
  const fallback=await clientKey();
  expect(await clientKey('203.0.113.1','198.51.100.1')).toBe(fallback);
  expect(await clientKey('203.0.113.2','198.51.100.2')).toBe(fallback);
  vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','false');
  expect(await clientKey('203.0.113.3')).toBe(fallback);
 });
 it('uses separate stable hashed buckets for trusted client addresses',async()=>{
  vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','true');
  const first=await clientKey('203.0.113.1');
  expect(first).toMatch(/^cloudflare:[a-f0-9]{64}$/);
  expect(first).not.toContain('203.0.113.1');
  expect(await clientKey('203.0.113.1','198.51.100.2')).toBe(first);
  expect(await clientKey('203.0.113.2')).not.toBe(first);
 });
 it('normalizes equivalent IPv6 spellings to the same bucket',async()=>{
  vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','true');
  expect(await clientKey('2001:0DB8:0:0:0:0:0:1')).toBe(await clientKey('2001:db8::1'));
 });
 it.each([undefined,'','not-an-ip','203.0.113.1, 203.0.113.2','203.0.113.1:443','[2001:db8::1]','fe80::1%eth0'])(
  'keeps missing or invalid trusted header %s in the fallback bucket',async(ip)=>{
   const fallback=await clientKey();
   vi.stubEnv('TRUST_CLOUDFLARE_CLIENT_IP','true');
   expect(await clientKey(ip,'203.0.113.1')).toBe(fallback);
  }
 );
 it('still rejects an invalid origin before attempting login',async()=>{
  auth.trustedOrigin.mockReturnValue(false);
  const response=await POST(new Request('https://underreview.example/api/auth/login',{method:'POST',body:'username=operator'}));
  expect(response.status).toBe(403);
  expect(auth.login).not.toHaveBeenCalled();
 });
});
