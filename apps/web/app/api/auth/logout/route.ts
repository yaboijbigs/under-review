import { cookies } from 'next/headers';
import { getSession,logout,sessionCookie,trustedOrigin,validCsrf } from '@under-review/core/auth';
import { config } from '@under-review/core/config';
export async function POST(request:Request){
 const token=(await cookies()).get('ur_session')?.value;const session=await getSession(token);const form=new URLSearchParams(await request.text());
 if(!trustedOrigin(request.headers.get('origin'))||!session||!validCsrf(session,form.get('csrf')))return new Response('Forbidden',{status:403});
 await logout(token);return new Response(null,{status:303,headers:{Location:new URL('/',config.siteUrl).toString(),'Set-Cookie':sessionCookie('',true)}});
}
