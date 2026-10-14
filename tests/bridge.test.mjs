import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'cord-bridge-test-'));let app=createApp({databasePath:join(dir,'db.sqlite'),demo:true});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base=`http://127.0.0.1:${app.server.address().port}`,cookie='';
  async function api(path,body,options={}){const r=await fetch(base+path,{method:options.method||(body===undefined?'GET':'POST'),headers:{'content-type':'application/json',...(options.token?{authorization:`Bearer ${options.token}`}:{cookie}),...(options.headers||{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return {status:r.status,...await r.json()};}
  await api('/api/auth/demo',{});
  async function pair(runtime='codex'){
    const p=await api('/api/agent-connections',{workspaceId:'ws-cord',runtime,name:'Test '+runtime});assert.equal(p.status,201);
    const code=/--pair (\w+)/.exec(p.prompt)[1];const e=await api('/api/bridge/enroll',{code,runtime,deviceName:'Test device',version:'2'});assert.equal(e.status,201);return {...p,...e,code};
  }
  async function message(agent,content='Hello'){
    const dm=await api('/api/dms',{workspaceId:'ws-cord',agentId:agent.agentId});const sent=await api('/api/messages',{targetType:'dm',targetId:dm.id,content});assert.equal(sent.status,201);return {dm,sent};
  }
  return {dir,get app(){return app;},base,api,pair,message,async restart(){await new Promise(r=>app.server.close(r));app=createApp({databasePath:join(dir,'db.sqlite'),demo:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;},async close(){await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}};
}
async function withFixture(fn){const f=await fixture();try{await fn(f);}finally{await f.close();}}

test('single-use pairing is runtime-bound, expiring, hashed and never exposes the device credential',()=>withFixture(async f=>{
  const p=await f.api('/api/agent-connections',{workspaceId:'ws-cord',runtime:'codex'});const code=/--pair (\w+)/.exec(p.prompt)[1];
  assert.equal((await f.api('/api/bridge/enroll',{code,runtime:'claude'})).status,400);
  const e=await f.api('/api/bridge/enroll',{code,runtime:'codex'});assert.equal(e.status,201);
  assert.equal((await f.api('/api/bridge/enroll',{code,runtime:'codex'})).status,401);
  const stored=f.app.store.get('SELECT * FROM bridge_devices WHERE agent_id=?',e.agentId);assert.notEqual(stored.token_hash,e.token);
  const bootstrap=await f.api('/api/bootstrap');assert.equal(bootstrap.agents.find(a=>a.id===e.agentId).status,'online');assert.ok(!JSON.stringify(bootstrap).includes(e.token));
  const expired=await f.api('/api/agent-connections',{workspaceId:'ws-cord',runtime:'hermes'});f.app.store.run('UPDATE bridge_pairings SET expires_at=? WHERE agent_id=?','2000-01-01T00:00:00Z',expired.agentId);
  assert.equal((await f.api('/api/bridge/enroll',{code:/--pair (\w+)/.exec(expired.prompt)[1],runtime:'hermes'})).status,401);
}));

test('durable jobs claim once, isolate devices, preserve context, and accept one final agent reply',()=>withFixture(async f=>{
  const a=await f.pair(),b=await f.pair('claude');const {dm}=await f.message(a,'Remember this conversation');
  await f.message(a,'Next message');const token=a.token;
  const claimed=await f.api('/api/bridge/poll',{}, {token});assert.equal(claimed.job.message,'Remember this conversation');assert.equal(claimed.job.messages.length,1);
  assert.equal((await f.api('/api/bridge/poll',{}, {token})).job,null);
  assert.equal((await f.api(`/api/bridge/jobs/${claimed.job.id}/complete`,{reply:'Hijack'},{token:b.token})).status,404);
  const complete=()=>f.api(`/api/bridge/jobs/${claimed.job.id}/complete`,{reply:'Real adapter reply'},{token});
  assert.equal((await complete()).ok,true);assert.equal((await complete()).ok,true);
  const messages=(await f.api(`/api/messages?type=dm&id=${dm.id}`)).messages;assert.equal(messages.filter(m=>m.author_type==='agent').length,1);
  assert.equal((await f.api('/api/bridge/poll',{}, {token})).job.message,'Next message');
  assert.equal(f.app.store.get('SELECT COUNT(*) n FROM runs WHERE agent_id=?',a.agentId).n,2);
}));

test('permissions, pause, approval decisions, cancellation, revoke and private run visibility',()=>withFixture(async f=>{
  const a=await f.pair();const {dm}=await f.message(a);
  await f.api(`/api/agent-connections/${a.agentId}/pause`,{paused:true});assert.equal((await f.api('/api/bridge/poll',{}, {token:a.token})).job,null);
  await f.api(`/api/agent-connections/${a.agentId}/pause`,{paused:false});const {job}=await f.api('/api/bridge/poll',{}, {token:a.token});
  const approval=await f.api(`/api/bridge/jobs/${job.id}/approval`,{title:'Run a command?',detail:'npm test'},{token:a.token});
  await f.api(`/api/approvals/${approval.id}`,{decision:'approved'});
  const status=await f.api(`/api/bridge/jobs/${job.id}/approval-status`,undefined,{token:a.token});assert.equal(status.approvals[0].status,'approved');
  await f.api(`/api/runs/${job.id}/cancel`,{});assert.equal((await f.api(`/api/bridge/jobs/${job.id}/heartbeat`,{}, {token:a.token})).status,'cancelled');
  assert.equal((await f.api(`/api/bridge/jobs/${job.id}/complete`,{reply:'Late result'},{token:a.token})).status,409);
  await f.api(`/api/agent-connections/${a.agentId}/revoke`,{});assert.equal((await f.api('/api/bridge/poll',{}, {token:a.token})).status,401);
  const invite=await f.api('/api/invites',{workspaceId:'ws-cord'});await f.api('/api/auth/register',{username:'bridge-member',password:'member-password',displayName:'Member',inviteCode:invite.code});
  assert.equal((await f.api('/api/agent-connections',{runtime:'claude'})).status,403);
  assert.ok(!(await f.api('/api/bootstrap')).runs.some(r=>r.target_id===dm.id));
  assert.ok(!(await f.api('/api/runs')).runs.some(r=>r.target_id===dm.id));
}));

test('expired execution lease fails without executing again and account settings persist',()=>withFixture(async f=>{
  const a=await f.pair();await f.message(a);const {job}=await f.api('/api/bridge/poll',{}, {token:a.token});
  f.app.store.run('UPDATE bridge_jobs SET lease_until=? WHERE id=?','2000-01-01T00:00:00Z',job.id);
  assert.equal((await f.api('/api/bridge/poll',{}, {token:a.token})).job,null);
  assert.equal(f.app.store.get('SELECT status FROM runs WHERE id=?',job.id).status,'failed');
  assert.equal((await f.api('/api/settings',{theme:'light',density:'compact',fontSize:16,enterToSend:false},{method:'PATCH'})).status,200);
  const s=(await f.api('/api/bootstrap')).settings;assert.equal(s.theme,'light');assert.equal(s.enterToSend,false);
  assert.equal((await f.api('/api/settings',{fontSize:900},{method:'PATCH'})).status,400);
  assert.equal((await f.api('/api/account/password',{currentPassword:'wrong',newPassword:'new-password'})).status,400);
  assert.equal((await f.api('/api/account/password',{currentPassword:'demo1234',newPassword:'new-password'})).status,200);
  assert.equal((await f.api('/api/auth/login',{username:'stefan',password:'new-password'})).status,200);
}));

test('offline agent jobs and saved preferences survive a Cord server restart',()=>withFixture(async f=>{
  const a=await f.pair();await f.message(a,'Keep this queued');
  await f.api('/api/settings',{theme:'light'},{method:'PATCH'});
  await f.restart();
  assert.equal((await f.api('/api/bootstrap')).settings.theme,'light');
  const {job}=await f.api('/api/bridge/poll',{}, {token:a.token});assert.equal(job.message,'Keep this queued');
  assert.equal((await f.api(`/api/bridge/jobs/${job.id}/complete`,{reply:'Back online'},{token:a.token})).ok,true);
}));

test('downloaded bundle and real OPAYA HTTP adapter worker complete an end-to-end job',()=>withFixture(async f=>{
  let received;
  const gateway=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}
    let raw='';for await(const part of req)raw+=part;received=JSON.parse(raw);
    res.end(JSON.stringify({choices:[{message:{content:'Connected through the OPAYA adapter.'}}]}));
  });
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));let child;
  try{
    const response=await fetch(f.base+'/bridge/bundle.json');assert.equal(response.status,200);const bundle=await response.json();assert.ok(bundle.files.some(f=>f.path==='runner.cjs'));
    const a=await f.pair('openclaw');const {dm}=await f.message(a,'Say hello');
    const config=join(f.dir,'connection.json');writeFileSync(config,JSON.stringify({server:f.base,token:a.token,agentId:a.agentId,local:{runtime:'openclaw',cwd:f.dir,agent:{id:a.agentId,name:'Mock runtime',protocol:'openai',provider:'custom',transport:'http',endpoint:`http://127.0.0.1:${gateway.address().port}/v1`,model:'test-model',args:[]}}}));
    child=spawn(process.execPath,[resolve('bridge/runner.cjs'),'--config',config,'--foreground'],{stdio:['ignore','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',c=>errors+=c);
    let reply;for(let n=0;n<100;n++){const messages=(await f.api(`/api/messages?type=dm&id=${dm.id}`)).messages;reply=messages.find(m=>m.author_type==='agent');if(reply)break;await delay(80);}
    assert.equal(reply?.content,'Connected through the OPAYA adapter.',errors);assert.equal(received.model,'test-model');assert.ok(received.messages.at(-1).content.includes('Say hello'));
  }finally{
    if(child){child.kill();await new Promise(r=>child.once('exit',r));}await new Promise(r=>gateway.close(r));
  }
}));
