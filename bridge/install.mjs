#!/usr/bin/env node
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const options={};
for(let i=2;i<process.argv.length;i++){const key=process.argv[i].replace(/^--/,'');if(['foreground','help'].includes(key))options[key]=true;else options[key]=process.argv[++i];}
if(options.help||!options.server||!options.pair||!options.runtime){console.log('node cord-install.mjs --server https://cord.example --pair CODE --runtime claude|codex|hermes|openclaw|opaya [--cwd DIR] [--foreground]');process.exit(options.help?0:1);}
try{
  const url=new URL(options.server);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Use the Cord server origin.');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Remote connections require HTTPS.');
  const res=await fetch(url.origin+'/bridge/bundle.json',{redirect:'error',signal:AbortSignal.timeout(30_000)});
  if(!res.ok)throw new Error('Bridge download failed: HTTP '+res.status);
  const raw=await res.text();if(raw.length>4*1024*1024)throw new Error('Bridge bundle exceeds size limit.');
  const bundle=JSON.parse(raw);if(bundle.version!=='cord-bridge/2'||!Array.isArray(bundle.files)||bundle.files.length>100)throw new Error('Unsupported bridge bundle.');
  const digest=createHash('sha256').update(raw).digest('hex');
  const root=join(process.env.CORD_HOME||join(homedir(),'.cord'),'runtimes',digest);
  for(const file of bundle.files){
    if(!/^[\w./-]+$/.test(file.path)||file.path.startsWith('/')||file.path.split('/').some(x=>['..','.',''].includes(x)))throw new Error('Unsafe bundle path');
    const content=Buffer.from(file.content,'base64');if(createHash('sha256').update(content).digest('hex')!==file.sha256)throw new Error('Bridge file checksum mismatch');
    const target=join(root,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});
    const temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,content,{mode:0o600});await rename(temp,target);
  }
  const require=createRequire(import.meta.url),runner=require(join(root,'runner.cjs'));
  await runner.main(options);
}catch(error){console.error('Cord connection failed: '+error.message);process.exitCode=1;}
