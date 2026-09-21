import { login,sessionCookie,trustedOrigin } from '@under-review/core/auth';
import { config } from '@under-review/core/config';
export async function POST(request:Request){
 if(!trustedOrigin(request.headers.get('origin')))return new Response('Invalid origin',{status:403});
 const body=await request.text();if(body.length>4096)return new Response('Request too large',{status:413});
 const form=new URLSearchParams(body);
 try{const token=await login(form.get('username')??'',form.get('password')??'','private-staging');
  if(!token)return Response.redirect(new URL('/admin/login?error=invalid_credentials',config.siteUrl),303);
  return new Response(null,{status:303,headers:{Location:new URL('/admin',config.siteUrl).toString(),'Set-Cookie':sessionCookie(token)}});
 }catch{return Response.redirect(new URL('/admin/login?error=login_unavailable_or_rate_limited',config.siteUrl),303);}
}
