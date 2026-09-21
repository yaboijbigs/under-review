import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
await mkdir('deploy/private',{recursive:true});
const password=randomBytes(24).toString('base64url');
const values={POSTGRES_PASSWORD:randomBytes(24).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex'),TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex'),UR_ADMIN_PASSWORD:password,WORKER_IMAGE:'under-review-worker:local',WEB_IMAGE:'under-review-web:local'};
await writeFile('deploy/private/staging.env',Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{flag:'wx',mode:0o600});
await writeFile('deploy/private/access.txt',`Under Review private staging\nAdmin username: owner\nAdmin password: ${password}\n\nForward a local port using your existing VPS SSH access:\nssh -N -L 4380:127.0.0.1:4380 root@185.28.23.55\n\nThen open http://localhost:4380/admin\nStop any local dev server on port 4380 before forwarding.\n`,{flag:'wx',mode:0o600});
console.log('Created private staging configuration and access instructions; secret values were not logged.');
