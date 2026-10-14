import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
let bundle;
export async function bridgeDownload(req,res,url,root){
  if(!['/bridge/install.mjs','/bridge/bundle.json'].includes(url.pathname))return false;
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return true;}
  let body;
  if(url.pathname.endsWith('install.mjs'))body=await readFile(join(root,'bridge','install.mjs'));
  else{
    if(!bundle){
      const manifest=JSON.parse(await readFile(join(root,'bridge','manifest.json'),'utf8'));
      const files=[];
      for(const path of manifest.files){
        if(!/^[\w./-]+$/.test(path)||path.includes('..'))throw new Error('Invalid bridge manifest path');
        const content=await readFile(join(root,'bridge',path));
        files.push({path,content:content.toString('base64'),sha256:createHash('sha256').update(content).digest('hex')});
      }
      bundle=JSON.stringify({version:'cord-bridge/2',source:manifest.source,files});
    }
    body=bundle;
  }
  res.writeHead(200,{'content-type':url.pathname.endsWith('.json')?'application/json':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:body);return true;
}
