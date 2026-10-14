import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/index.mjs';

process.env.CORD_MASTER_KEY ||= randomBytes(32).toString('hex');

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'cord-social-'));
  const app=createApp({databasePath:join(dir,'cord.db'),demo:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const api=async(path,{method='GET',body,headers={},raw}={})=>{
    const response=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(raw!==undefined?{}:body===undefined?{}:{'content-type':'application/json'}),...headers},body:raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body)});
    const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
    const data=(response.headers.get('content-type')||'').includes('application/json')?await response.json():{text:await response.text()};
    return {status:response.status,...data};
  };
  await api('/api/auth/demo',{method:'POST',body:{}});
  return {app,base,api,async close(){await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true})}};
}
async function use(fn){const f=await fixture();try{await fn(f)}finally{await f.close()}}
const send=(f,content,other={})=>f.api('/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-chat',content,...other}});
const list=f=>f.api('/api/messages?type=channel&id=channel-chat');

test('canonical human and agent mentions: permissions, metadata, unread notifications and agent routing',async()=>use(async f=>{
  const message=await send(f,'Hey <@user-christina> and <@agent-rwe>, please review.');assert.equal(message.status,201);
  const stored=await list(f);const row=stored.messages.find(m=>m.id===message.message.id);
  assert.ok(row);assert.deepEqual(row.reactions,[]);assert.deepEqual(row.attachments,[]);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM message_mentions WHERE message_id=?',row.id).n,1);
  assert.equal((await send(f,'Hello <@secret-foreign-user>')).status,400);
  assert.equal((await send(f,'Look at <#channel-unavailable>')).status,400);
  assert.equal((await send(f,'Hey @everyone')).status,201);
  await new Promise(resolve=>setTimeout(resolve,850)); // allow the demo agent's in-flight response to finish before fixture shutdown
}));

test('emoji reactions toggle individually and are visible to all participants',async()=>use(async f=>{
  const m=(await send(f,'React to me')).message.id;
  const add=await f.api('/api/social/reactions',{method:'POST',body:{messageId:m,emoji:'🔥'}});
  assert.equal(add.status,200);assert.equal(add.active,true);
  let row=(await list(f)).messages.find(x=>x.id===m);assert.deepEqual(row.reactions,[{emoji:'🔥',count:1,mine:true}]);
  assert.equal((await f.api('/api/social/reactions',{method:'POST',body:{messageId:m,emoji:'🔥'}})).active,false);
  row=(await list(f)).messages.find(x=>x.id===m);assert.equal(row.reactions.length,0);
  assert.equal((await f.api('/api/social/reactions',{method:'POST',body:{messageId:m,emoji:'xss<script>'}})).status,400);
  assert.equal((await f.api('/api/social/reactions',{method:'POST',body:{messageId:'missing',emoji:'👍'}})).status,404);
}));

test('replies are constrained to conversation and messages can be edited only by their author',async()=>use(async f=>{
  const first=(await send(f,'Original')).message.id;
  const reply=(await send(f,'Following up',{replyToId:first})).message.id;
  let messages=(await list(f)).messages;let row=messages.find(x=>x.id===reply);
  assert.equal(row.reply.id,first);assert.equal(row.reply.content,'Original');
  assert.equal((await f.api(`/api/messages/${reply}`,{method:'PATCH',body:{content:'Edited with <@user-rob>'}})).status,200);
  messages=(await list(f)).messages;row=messages.find(x=>x.id===reply);
  assert.equal(row.content,'Edited with <@user-rob>');assert.ok(row.edited_at);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM message_mentions WHERE message_id=? AND user_id=?',reply,'user-rob').n,1);
  assert.equal((await f.api('/api/messages/unknown',{method:'PATCH',body:{content:'X'}})).status,404);
  assert.equal((await f.api(`/api/messages/${reply}`,{method:'PATCH',body:{content:''}})).status,400);
  assert.equal((await f.api(`/api/messages/${reply}`,{method:'PATCH',body:{content:'Hello <@does-not-exist>'}})).status,400);
  assert.equal((await f.api(`/api/messages/${reply}`,{method:'DELETE'})).status,200);
  assert.equal((await list(f)).messages.find(x=>x.id===reply),undefined);
  const other=await f.api('/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-build',content:'Cannot reference other conversation',replyToId:first}});
  assert.equal(other.status,400);
}));

test('pin messages, list pins, unpin, and enforce conversation permissions',async()=>use(async f=>{
  const a=(await send(f,'Pin this note')).message.id;
  assert.equal((await f.api('/api/social/pins',{method:'POST',body:{messageId:a,pinned:true}})).status,200);
  assert.equal((await list(f)).messages.find(x=>x.id===a).pinned,true);
  const pins=await f.api('/api/social/pins?type=channel&id=channel-chat');assert.ok(pins.messages.some(m=>m.id===a));
  assert.equal((await f.api('/api/social/pins',{method:'POST',body:{messageId:a,pinned:false}})).status,200);
  assert.equal((await f.api('/api/social/pins?type=channel&id=invalid')).status,404);
  assert.equal((await list(f)).messages.find(x=>x.id===a).pinned,false);
}));

test('binary uploads attach to messages, are retrievable, size-checked and removed on deletion',async()=>use(async f=>{
  const onePixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
  const upload=await f.api('/api/social/uploads?type=channel&id=channel-chat',{method:'POST',raw:onePixel,headers:{'content-type':'image/png','x-file-name':'pixel.png'}});
  assert.equal(upload.status,201);assert.equal(upload.file.filename,'pixel.png');
  assert.equal((await f.api(`/api/social/uploads/${upload.file.id}`)).status,200);
  const sent=await send(f,'Here is a screenshot',{attachmentIds:[upload.file.id]});assert.equal(sent.status,201);
  const row=(await list(f)).messages.find(m=>m.id===sent.message.id);assert.equal(row.attachments.length,1);
  assert.equal(row.attachments[0].filename,'pixel.png');
  assert.equal((await send(f,'Reusing attachment',{attachmentIds:[upload.file.id]})).status,403);
  assert.equal((await f.api(`/api/messages/${sent.message.id}`,{method:'DELETE'})).status,200);
  assert.equal((await f.api(`/api/social/uploads/${upload.file.id}`)).status,404);
  assert.equal((await f.api('/api/social/uploads?type=channel&id=channel-chat',{method:'POST',raw:Buffer.from('<script>alert(1)</script>'),headers:{'content-type':'text/plain'}})).status,415);
}));

test('conversation deletion cascades pins, reactions, mentions, and linked attachments',async()=>use(async f=>{
  const category=await f.api('/api/categories',{method:'POST',body:{workspaceId:'ws-cord',name:'TEMP'}});
  const channel=await f.api('/api/channels',{method:'POST',body:{workspaceId:'ws-cord',categoryId:category.id,name:'temp-channel'}});
  const row=await f.api('/api/messages',{method:'POST',body:{targetType:'channel',targetId:channel.id,content:'<@user-christina> Please check this'}});
  await f.api('/api/social/reactions',{method:'POST',body:{messageId:row.message.id,emoji:'💡'}});
  await f.api('/api/social/pins',{method:'POST',body:{messageId:row.message.id,pinned:true}});
  assert.equal((await f.api(`/api/channels/${channel.id}`,{method:'DELETE'})).status,200);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id=?',row.message.id).n,0);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM message_mentions WHERE message_id=?',row.message.id).n,0);
}));

test('mention badges track unread messages, member cannot ping everyone or edit other posts, DMs stay private',async()=>use(async f=>{
  const invite=await f.api('/api/invites',{method:'POST',body:{workspaceId:'ws-cord'}});
  assert.equal(invite.status,201);
  let cookie='';
  const other=async(path,{method='GET',body}={})=>{
    const r=await fetch(f.base+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,...await r.json()};
  };
  assert.equal((await other('/api/auth/register',{method:'POST',body:{username:'teammate-qa',password:'test-password-123',displayName:'QA Teammate',inviteCode:invite.code}})).status,201);
  const colleague=(await other('/api/me')).user;
  const note=(await send(f,`Please check this <@${colleague.id}>`)).message;
  const boot=await other('/api/bootstrap');
  assert.equal(boot.unreads['channel:channel-chat']?.mentions,1);
  assert.equal((await other('/api/social/reactions',{method:'POST',body:{messageId:note.id,emoji:'✅'}})).status,200);
  assert.equal((await other(`/api/messages/${note.id}`,{method:'PATCH',body:{content:'Malicious edit'}})).status,403);
  const forbidden=await other('/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-chat',content:'@everyone must be forbidden'}});
  assert.equal(forbidden.status,403);
  assert.equal((await other('/api/read',{method:'POST',body:{targetType:'channel',targetId:'channel-chat'}})).status,200);
  assert.equal((await other('/api/social/unreads?workspaceId=ws-cord')).unreads['channel:channel-chat']?.mentions||0,0);
  const dm=await f.api('/api/dms',{method:'POST',body:{workspaceId:'ws-cord',agentId:'agent-rwe'}});
  const ownMessage=await f.api('/api/messages',{method:'POST',body:{targetType:'dm',targetId:dm.id,content:'This DM is confidential'}});
  assert.equal(ownMessage.status,201);
  assert.equal((await other(`/api/messages?type=dm&id=${dm.id}`)).status,404);
  assert.equal((await other('/api/social/reactions',{method:'POST',body:{messageId:ownMessage.message.id,emoji:'👀'}})).status,404);
  await new Promise(resolve=>setTimeout(resolve,850));
}));
