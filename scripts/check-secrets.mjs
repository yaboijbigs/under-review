import { execFileSync } from 'node:child_process';
import { readFileSync,existsSync } from 'node:fs';

const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw new Error('Stage the intended source files before scanning.');
const secrets=[];
for(const file of ['.env','deploy/private/staging.env','deploy/private/public.env','deploy/private/public-tunnel.env','deploy/private/local-admin.json','deploy/private/x-app.env']){
 if(!existsSync(file))continue;
 const raw=readFileSync(file,'utf8');
 if(file.endsWith('.json')){const value=JSON.parse(raw).password;if(value)secrets.push(value);}
 else for(const line of raw.split(/\r?\n/)){const match=line.match(/^([^=#]+)=(.+)$/);if(match&&/password|secret|token|database_url/i.test(match[1])&&match[2].length>=12)secrets.push(match[2]);}
}
const failures=[];
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,/\bAKIA[A-Z0-9]{16}\b/,/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/];
for(const file of files){
 if(/(^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519)$/.test(file)&&!file.endsWith('.env.example')||/^deploy\/private\//.test(file)||/\.(?:pem|key|dump|backup)$/.test(file))failures.push({file,rule:'private-file'});
 const bytes=execFileSync('git',['show',`:${file}`],{maxBuffer:128*1024*1024});
 const text=bytes.toString('utf8');
 if(patterns.some(pattern=>pattern.test(text)))failures.push({file,rule:'credential-pattern'});
 if(secrets.some(secret=>bytes.includes(Buffer.from(secret))))failures.push({file,rule:'known-local-secret'});
}
if(failures.length){console.error(JSON.stringify({passed:false,failures}));process.exit(1);}
console.log(JSON.stringify({passed:true,stagedFiles:files.length,checks:['private-file exclusion','credential patterns','exact local secret exclusion']}));
