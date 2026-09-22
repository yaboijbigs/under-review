import { login,sessionCookie,trustedOrigin } from '@under-review/core/auth';
import { config } from '@under-review/core/config';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

function loginClientKey(request:Request):string{
 // Enable only behind Cloudflare Tunnel, with no public path to the web container.
 if(process.env.TRUST_CLOUDFLARE_CLIENT_IP!=='true')return 'untrusted-client';
 const ip=request.headers.get('cf-connecting-ip');
 if(!ip||!isIP(ip)||ip.includes('%'))return 'untrusted-client';
 const canonical=isIP(ip)===6?new URL(`http://[${ip}]/`).hostname:ip;
 return `cloudflare:${createHash('sha256').update(canonical).digest('hex')}`;
}
export async function POST(request:Request){
 if(!trustedOrigin(request.headers.get('origin')))return new Response('Invalid origin',{status:403});
 const body=await request.text();if(body.length>4096)return new Response('Request too large',{status:413});
 const form=new URLSearchParams(body);
 try{const token=await login(form.get('username')??'',form.get('password')??'',loginClientKey(request));
  if(!token)return Response.redirect(new URL('/admin/login?error=invalid_credentials',config.siteUrl),303);
  return new Response(null,{status:303,headers:{Location:new URL('/admin',config.siteUrl).toString(),'Set-Cookie':sessionCookie(token)}});
 }catch{return Response.redirect(new URL('/admin/login?error=login_unavailable_or_rate_limited',config.siteUrl),303);}
}
