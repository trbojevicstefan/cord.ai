import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server/index.mjs';

process.env.CORD_MASTER_KEY ||= randomBytes(32).toString('hex');

async function fixture({demo=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'cord-ai-test-'));
  const app=createApp({databasePath:join(directory,'cord.db'),demo});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  async function api(path,{method='GET',body,headers={}}={}) {
    const r=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
    const data=await r.json();return {status:r.status,...data};
  }
  return {base,api,app,async close(){await new Promise((resolve,reject)=>app.server.close(err=>err?reject(err):resolve()));rmSync(directory,{recursive:true,force:true});}};
}
const login=async f=>{const x=await f.api('/api/auth/demo',{method:'POST',body:{}});assert.equal(x.status,200);return (await f.api('/api/bootstrap')).workspace.id};
const post=(f,path,body)=>f.api(path,{method:'POST',body});
const patch=(f,path,body)=>f.api(path,{method:'PATCH',body});
const del=(f,path)=>f.api(path,{method:'DELETE'});
async function withFixture(fn){const f=await fixture();try{await fn(f)}finally{await f.close()}}

test('health, security and seeded workspace', async()=>withFixture(async f=>{
  assert.equal((await f.api('/api/health')).status,200);
  assert.equal((await f.api('/api/bootstrap')).status,401);
  const ws=await login(f);
  const bootstrap=await f.api('/api/bootstrap');assert.equal(ws,'ws-cord');
  assert.ok(bootstrap.threads.length>=7);assert.ok(bootstrap.agents.some(a=>a.name==='RWE Design'));
  assert.equal(bootstrap.members.length,3);
  assert.equal((await f.api('/api/messages?type=thread&id=not-a-thread')).status,404);
}));

test('create categories, channels and nested threads; thread edit/close/reopen/lock',async()=>withFixture(async f=>{
  const ws=await login(f);
  const category=await post(f,'/api/categories',{workspaceId:ws,name:'ENGINEERING'});assert.equal(category.status,201);
  const channel=await post(f,'/api/channels',{workspaceId:ws,categoryId:category.id,name:'agent ops'});assert.equal(channel.status,201);
  const thread=await post(f,'/api/threads',{channelId:channel.id,name:'Debug OPAYA',agentId:'agent-rwe',agentMode:'mentions',firstMessage:'First design spec'});assert.equal(thread.status,201);
  assert.ok((await f.api('/api/bootstrap')).threads.some(t=>t.id===thread.id&&t.channel_id===channel.id));
  assert.ok((await f.api(`/api/messages?type=channel&id=${channel.id}`)).messages.some(m=>JSON.parse(m.metadata).thread_ref===thread.id));
  const edited=await patch(f,`/api/threads/${thread.id}`,{name:'OPAYA Bridge - design',slowmode:5,autoHideDays:7,spoiler:true,agentMode:'off'});assert.equal(edited.status,200);
  let target=(await f.api('/api/bootstrap')).threads.find(t=>t.id===thread.id);assert.equal(target.name,'OPAYA Bridge - design');assert.equal(target.slowmode,5);assert.equal(target.spoiler,1);
  assert.equal((await post(f,'/api/thread-actions',{threadId:thread.id,action:'close'})).status,200);
  assert.equal((await post(f,'/api/messages',{targetType:'thread',targetId:thread.id,content:'not allowed'})).status,403);
  assert.equal((await post(f,'/api/thread-actions',{threadId:thread.id,action:'reopen'})).status,200);
  assert.equal((await post(f,'/api/thread-actions',{threadId:thread.id,action:'lock'})).status,200);
  assert.equal((await post(f,'/api/thread-actions',{threadId:thread.id,action:'unlock'})).status,200);
  assert.equal((await del(f,`/api/threads/${thread.id}`)).status,200);
  assert.equal((await f.api(`/api/messages?type=thread&id=${thread.id}`)).status,404);
}));

test('message in agent-assigned thread and DM produces clearly demo-marked answer',async()=>withFixture(async f=>{
  await login(f);
  const sent=await post(f,'/api/messages',{targetType:'thread',targetId:'thread-be',content:'Can you explain our database access?'});assert.equal(sent.status,201);
  await new Promise(resolve=>setTimeout(resolve,810));
  const thread=await f.api('/api/messages?type=thread&id=thread-be');
  assert.ok(thread.messages.some(m=>m.author_type==='agent'&&m.content.toLowerCase().includes('demo response')));
  const sentDm=await post(f,'/api/messages',{targetType:'dm',targetId:'dm-rwe',content:'Hi there'});assert.equal(sentDm.status,201);
  await new Promise(resolve=>setTimeout(resolve,810));
  const dm=await f.api('/api/messages?type=dm&id=dm-rwe');assert.ok(dm.messages.some(m=>m.author_type==='agent'&&m.content.includes('simulated response')));
  const runs=await f.api('/api/runs?workspaceId=ws-cord');assert.ok(runs.runs.some(r=>r.status==='completed'));
}));

test('preferences, search and mark read',async()=>withFixture(async f=>{
  await login(f);
  assert.equal((await post(f,'/api/preferences',{targetType:'thread',targetId:'thread-be',muted:true,favorite:true,notificationLevel:'mentions'})).status,200);
  const row=(await f.api('/api/bootstrap')).preferences.find(p=>p.target_id==='thread-be');assert.equal(row.muted,1);assert.equal(row.favorite,1);
  assert.equal((await post(f,'/api/read',{targetType:'thread',targetId:'thread-be'})).status,200);
  assert.ok((await f.api('/api/bootstrap')).reads.some(r=>r.target_id==='thread-be'));
  assert.equal((await f.api('/api/search?workspaceId=ws-cord&q=database')).status,200);
}));

test('invites enable registration and members have restricted management permissions',async()=>withFixture(async f=>{
  await login(f);
  const invite=await post(f,'/api/invites',{workspaceId:'ws-cord'});assert.equal(invite.status,201);
  const registration=await post(f,'/api/auth/register',{inviteCode:invite.code,username:'newtester',displayName:'New Tester',password:'safe-password-2026'});
  assert.equal(registration.status,201);
  const b=await f.api('/api/bootstrap');assert.equal(b.user.username,'newtester');
  const denied=await post(f,'/api/categories',{workspaceId:'ws-cord',name:'Nope'});assert.equal(denied.status,403);
  const own=await post(f,'/api/threads',{channelId:'channel-chat',name:'My allowed thread'});assert.equal(own.status,201);
  const editSomeone=await patch(f,'/api/threads/thread-be',{name:'Hijacked'});assert.equal(editSomeone.status,403);
  assert.equal((await del(f,'/api/threads/thread-be')).status,403);
  assert.equal((await post(f,'/api/messages',{targetType:'thread',targetId:own.id,content:'hello'})).status,201);
  assert.equal((await f.api('/api/audit?workspaceId=ws-cord')).status,403);
}));

test('deleting channels and categories cascades consistently',async()=>withFixture(async f=>{
  const ws=await login(f);
  const category=await post(f,'/api/categories',{workspaceId:ws,name:'TEMP'});
  const channel=await post(f,'/api/channels',{workspaceId:ws,categoryId:category.id,name:'temp-chat'});
  const thread=await post(f,'/api/threads',{channelId:channel.id,name:'Temporary'});
  assert.equal((await del(f,`/api/categories/${category.id}`)).status,200);
  assert.equal((await f.api('/api/bootstrap')).channels.find(x=>x.id===channel.id).category_id,null);
  assert.equal((await del(f,`/api/channels/${channel.id}`)).status,200);
  assert.equal((await f.api('/api/bootstrap')).threads.some(x=>x.id===thread.id),false);
}));

test('agent creation, encrypted key and signed OPAYA bridge request',async()=>withFixture(async f=>{
  const bridge=http.createServer(async(req,res)=>{
    const data=[];for await(const chunk of req)data.push(chunk);
    const payload=Buffer.concat(data).toString('utf8');
    const valid=createHmac('sha256','unit-test-bridge-key').update(payload).digest('hex');
    if(req.headers['x-cord-signature']!==`sha256=${valid}`){res.writeHead(403).end('bad signature');return}
    const input=JSON.parse(payload);
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({reply:`Connected to OPAYA bridge v1: ${input.message}`}));
  });
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  try {
    await login(f);
    const endpoint=`http://127.0.0.1:${bridge.address().port}/invoke`;
    const agent=await post(f,'/api/agents',{workspaceId:'ws-cord',name:'Live Bridge',type:'opaya',endpoint,secret:'unit-test-bridge-key',externalId:'opaya-local-agent'});
    assert.equal(agent.status,201);
    const bootstrap=await f.api('/api/bootstrap');
    assert.ok(bootstrap.agents.some(a=>a.id===agent.id&&!('secret_encrypted' in a)));
    const created=await post(f,'/api/threads',{channelId:'channel-chat',name:'Bridge smoke test',agentId:agent.id,agentMode:'auto'});
    assert.equal(created.status,201);
    assert.equal((await post(f,'/api/messages',{targetType:'thread',targetId:created.id,content:'Ping the bridge'})).status,201);
    await new Promise(resolve=>setTimeout(resolve,160));
    const result=await f.api(`/api/messages?type=thread&id=${created.id}`);
    assert.ok(result.messages.some(m=>m.author_type==='agent'&&m.content.includes('Connected to OPAYA bridge v1')));
    assert.equal((await del(f,`/api/agents/${agent.id}`)).status,200);
  } finally {await new Promise(resolve=>bridge.close(resolve))}
}));

test('branch a channel message into a thread while preserving its author and channel link',async()=>withFixture(async f=>{
  const ws=await login(f);
  const sent=await post(f,'/api/messages',{targetType:'channel',targetId:'channel-chat',content:'Discuss the launch plan'});
  assert.equal(sent.status,201);
  const source=(await f.api('/api/messages?type=channel&id=channel-chat')).messages.find(m=>m.content==='Discuss the launch plan');
  const other=await post(f,'/api/channels',{workspaceId:ws,name:'other-channel'});
  assert.equal((await post(f,'/api/threads',{channelId:other.id,name:'Wrong channel',sourceMessageId:source.id})).status,400);
  const created=await post(f,'/api/threads',{channelId:'channel-chat',name:'Launch plan',sourceMessageId:source.id,firstMessage:'Let us start here'});
  assert.equal(created.status,201);
  const messages=(await f.api(`/api/messages?type=thread&id=${created.id}`)).messages;
  assert.equal(messages.length,2);
  const copied=messages.find(m=>JSON.parse(m.metadata).source_message_id===source.id);
  assert.equal(copied.content,source.content);
  assert.equal(copied.author_id,source.author_id);
  assert.equal(copied.author_type,source.author_type);
  const original=(await f.api('/api/messages?type=channel&id=channel-chat')).messages.find(m=>m.id===source.id);
  assert.equal(original.content,source.content);
  assert.equal(JSON.parse(original.metadata).thread_ref,created.id);
  assert.equal((await post(f,'/api/threads',{channelId:'channel-chat',name:'Duplicate',sourceMessageId:source.id})).status,409);
}));

test('CSRF origin gate and forbidden static traversal',async()=>withFixture(async f=>{
  await login(f);
  assert.equal((await f.api('/api/profile',{method:'PATCH',body:{displayName:'Evil'},headers:{origin:'https://evil.example'}})).status,403);
  const rs=await fetch(f.base+'/private');assert.equal(rs.status,404);
}));
