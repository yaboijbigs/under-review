import { cookies } from 'next/headers';
import { getSession } from '@under-review/core/auth';
import { finishXConnection } from '@under-review/core/publishing';
import { config } from '@under-review/core/config';
export async function GET(request:Request){
 const session=await getSession((await cookies()).get('ur_session')?.value);if(!session||session.role!=='admin')return new Response('Forbidden',{status:403});
 const url=new URL(request.url);try{await finishXConnection(session.userId,url.searchParams.get('state')??'',url.searchParams.get('code')??'');return Response.redirect(new URL('/admin?message=X+account+connected%3B+posting+remains+disabled+until+explicitly+enabled',config.siteUrl));}catch{return Response.redirect(new URL('/admin?error=X_connection_failed',config.siteUrl));}
}
