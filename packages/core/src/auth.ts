import { randomBytes,randomUUID,createHash,timingSafeEqual } from 'node:crypto';
import { hash,verify } from '@node-rs/argon2';
import { query,audit } from './db.js';
import { config } from './config.js';

export interface Session {id:string;userId:string;username:string;role:'admin'|'reviewer';csrfToken:string;expiresAt:string}
export const sessionId=(token:string)=>createHash('sha256').update(token).digest('hex');
export async function createUser(username:string,password:string,role:'admin'|'reviewer'='admin'){
 if(!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)||password.length<14||password.length>256)throw new Error('Use a 3–64 character username and a password of at least 14 characters.');
 const id=randomUUID();await query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,await hash(password,{memoryCost:19456,timeCost:2,parallelism:1}),role]);await audit(id,'account.created',id,{role});return id;
}
export async function consumeRateLimit(key:string,limit=8,windowSeconds=900):Promise<boolean>{
 const row=(await query(`INSERT INTO rate_limits(key,count,window_start) VALUES($1,1,now())
 ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_start < now()-make_interval(secs=>$2) THEN 1 ELSE rate_limits.count+1 END,
 window_start=CASE WHEN rate_limits.window_start < now()-make_interval(secs=>$2) THEN now() ELSE rate_limits.window_start END RETURNING count`,[key,windowSeconds])).rows[0];return row.count<=limit;
}
export async function login(username:string,password:string,clientKey:string):Promise<string|null>{
 if(!await consumeRateLimit('login:'+clientKey,8)||!await consumeRateLimit('account-login:'+username,12))throw new Error('Too many attempts. Try again later.');
 const user=(await query('SELECT * FROM users WHERE username=$1',[username])).rows[0];
 if(!user||!await verify(user.password_hash,password)){await audit(null,'login.failed',null);return null;}
 const token=randomBytes(32).toString('base64url');const csrf=randomBytes(32).toString('base64url');
 await query("INSERT INTO sessions(id,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[sessionId(token),user.id,csrf]);
 await audit(user.id,'login.succeeded',null);return token;
}
export async function getSession(token:string|undefined):Promise<Session|null>{
 if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const row=(await query('SELECT s.*,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()',[sessionId(token)])).rows[0];
 return row?{id:row.id,userId:row.user_id,username:row.username,role:row.role,csrfToken:row.csrf_token,expiresAt:row.expires_at.toISOString()}:null;
}
export async function logout(token:string|undefined){if(token)await query('DELETE FROM sessions WHERE id=$1',[sessionId(token)]);}
export function validCsrf(session:Session,token:unknown):boolean {if(typeof token!=='string')return false;const a=Buffer.from(session.csrfToken),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);}
export function trustedOrigin(origin:string|null):boolean{try{return origin!==null&&new URL(origin).origin===new URL(config.siteUrl).origin;}catch{return false;}}
export function sessionCookie(token:string,clear=false){return `ur_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear?0:43200}${config.siteUrl.startsWith('https:')?'; Secure':''}`;}
