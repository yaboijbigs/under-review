import { randomBytes } from 'node:crypto';
import { writeFile,mkdir,access } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
try{await access(path.join(root,'.env'));console.log('.env already exists; preserved.');}catch{
 const password=randomBytes(24).toString('hex');
 const env=`COMPOSE_PROJECT_NAME=under-review\nPOSTGRES_USER=under_review\nPOSTGRES_DB=under_review\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://under_review:${password}@127.0.0.1:5439/under_review\nSITE_URL=http://localhost:4380\nPRIVATE_STAGING=true\nTARGET_SEASON=2026\nLIVE_POSTING_ALLOWED=false\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nTOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nBRAND_NAME=Under Review\nBRAND_TAGLINE=What actually swung the game?\n`;
 await writeFile(path.join(root,'.env'),env,{flag:'wx',mode:0o600});console.log('Created local configuration with random secrets.');
}
await mkdir(path.join(root,'data'),{recursive:true});
