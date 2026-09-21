import { parseArgs } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
const {values}=parseArgs({options:{'web-ref':{type:'string'},'worker-ref':{type:'string'}}});
async function resolveImage(component,ref){
 if(!/^[a-f0-9]{40}$/.test(ref??''))throw new Error(`Provide the verified full ${component} source commit.`);
 const name=`yaboijbigs/under-review-${component}`;
 const authorization=await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`);
 if(!authorization.ok)throw new Error(`Anonymous ${component} image authorization failed (${authorization.status}).`);
 const {token}=await authorization.json();
 const response=await fetch(`https://ghcr.io/v2/${name}/manifests/${ref}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.docker.distribution.manifest.v2+json'}});
 const digest=response.headers.get('docker-content-digest');
 if(!response.ok||!/^sha256:[a-f0-9]{64}$/.test(digest??''))throw new Error(`Public ${component} image is not ready (${response.status}).`);
 return {sourceCommit:ref,image:`ghcr.io/${name}@${digest}`,anonymousManifestVerified:true};
}
const [web,worker]=await Promise.all([resolveImage('web',values['web-ref']),resolveImage('worker',values['worker-ref'])]);
let environment=await readFile('deploy/private/staging.env','utf8');
for(const [key,value] of Object.entries({WEB_IMAGE:web.image,WORKER_IMAGE:worker.image})){
 if(!new RegExp(`^${key}=.*$`,'m').test(environment))throw new Error(`Missing private deployment key ${key}.`);
 environment=environment.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${value}`);
}
await writeFile('deploy/private/staging.env',environment,{mode:0o600});
const record={verifiedAt:new Date().toISOString(),web,worker};
await writeFile('deploy/images.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record));
