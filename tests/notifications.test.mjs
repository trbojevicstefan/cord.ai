import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

const request=async(base,cookie,path,{method='GET',body}={})=>{
  const res=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const json=await res.json();return {...json,status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0]};
};
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'cord-notify-test-'));
  const app=createApp({databasePath:join(directory,'cord.sqlite'),demo:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=async username=>{
    if(username==='stefan'){const r=await request(base,'','/api/auth/demo',{method:'POST',body:{}});assert.equal(r.status,200);return r.cookie}
    const r=await request(base,'','/api/auth/login',{method:'POST',body:{username,password:'demo1234'}});assert.equal(r.status,200);return r.cookie;
  };
  return {app,base,login,request:(cookie,path,options)=>request(base,cookie,path,options),async close(){await new Promise(r=>app.server.close(r));rmSync(directory,{force:true,recursive:true})}};
}
async function use(fn){const f=await fixture();try{await fn(f)}finally{await f.close()}}

// The existing demo has Stefan (owner), Christina (admin), Rob (member) and a
// pre-existing #general channel. All tests use real HTTP routes and SQLite.
test('mentions are persistent, private per recipient and can be read or dismissed',()=>use(async f=>{
  const stefan=await f.login('stefan'),christina=await f.login('christina'),rob=await f.login('rob');
  const x=await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-general',content:'Heads up <@user-christina> — please review this!'}});
  assert.equal(x.status,201);
  const list=await f.request(christina,'/api/notifications?workspaceId=ws-cord&filter=mentions');
  assert.equal(list.status,200);assert.equal(list.items.length,1);
  assert.equal(list.items[0].kind,'mention');assert.equal(list.items[0].message_id,x.message.id);
  assert.equal(list.summary.unread,1);
  const other=await f.request(rob,'/api/notifications?workspaceId=ws-cord');assert.equal(other.items.length,0);
  const hijack=await f.request(rob,`/api/notifications/${list.items[0].id}`,{method:'PATCH',body:{workspaceId:'ws-cord',read:true}});assert.equal(hijack.status,404);
  const read=await f.request(christina,`/api/notifications/${list.items[0].id}`,{method:'PATCH',body:{workspaceId:'ws-cord',read:true}});assert.equal(read.status,200);assert.equal(read.summary.unread,0);
  const unread=await f.request(christina,`/api/notifications/${list.items[0].id}`,{method:'PATCH',body:{workspaceId:'ws-cord',read:false}});assert.equal(unread.status,200);assert.equal(unread.summary.unread,1);
  const dismiss=await f.request(christina,`/api/notifications/${list.items[0].id}`,{method:'DELETE',body:{workspaceId:'ws-cord'}});assert.equal(dismiss.status,200);assert.equal(dismiss.summary.unread,0);
}));

test('DMs, replies, per-target mark read and unread filters',()=>use(async f=>{
  const stefan=await f.login('stefan'),christina=await f.login('christina');
  const dm=await f.request(stefan,'/api/dms',{method:'POST',body:{workspaceId:'ws-cord',userId:'user-christina'}});assert.ok(dm.id);
  const message=await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'dm',targetId:dm.id,content:'Private DM'} });assert.equal(message.status,201);
  const reply=await f.request(christina,'/api/messages',{method:'POST',body:{targetType:'dm',targetId:dm.id,content:'Got it!',replyToId:message.message.id}});assert.equal(reply.status,201);
  const mine=await f.request(stefan,'/api/notifications?workspaceId=ws-cord&filter=unread');assert.equal(mine.items.length,1);assert.equal(mine.items[0].kind,'reply');
  const hers=await f.request(christina,'/api/notifications?workspaceId=ws-cord&filter=unread');assert.equal(hers.items.length,1);assert.equal(hers.items[0].kind,'dm');
  const read=await f.request(christina,'/api/read',{method:'POST',body:{targetType:'dm',targetId:dm.id}});assert.equal(read.status,200);
  const after=await f.request(christina,'/api/notifications/summary?workspaceId=ws-cord');assert.equal(after.summary.unread,0);
  const all=await f.request(stefan,'/api/notifications/read-all',{method:'POST',body:{workspaceId:'ws-cord'}});assert.equal(all.status,200);assert.equal(all.summary.unread,0);
}));

test('muted channels/categories, mentions-only levels, and global toggles suppress new notifications',()=>use(async f=>{
  const stefan=await f.login('stefan'),christina=await f.login('christina');
  const mute=await f.request(christina,'/api/preferences',{method:'POST',body:{targetType:'category',targetId:'cat-team',muted:true}});assert.equal(mute.status,200);
  await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-chat',content:'Muted <@user-christina>'}});
  let inbox=await f.request(christina,'/api/notifications?workspaceId=ws-cord');assert.equal(inbox.items.length,0);
  await f.request(christina,'/api/preferences',{method:'POST',body:{targetType:'category',targetId:'cat-team',muted:false}});
  await f.request(christina,'/api/settings',{method:'PATCH',body:{notifyMentions:false,notifyDirectMessages:false,quietHoursStart:'22:00',quietHoursEnd:'07:00'}});
  await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-chat',content:'Suppressed <@user-christina>'}});
  inbox=await f.request(christina,'/api/notifications?workspaceId=ws-cord');assert.equal(inbox.items.length,0);
  const bad=await f.request(christina,'/api/settings',{method:'PATCH',body:{quietHoursStart:'25:00'}});assert.equal(bad.status,400);
  const loaded=await f.request(christina,'/api/bootstrap');assert.equal(loaded.settings.quietHoursStart,'22:00');assert.equal(loaded.settings.notifyMentions,false);
}));

test('joined thread activity and edited mentions notify once',()=>use(async f=>{
  const stefan=await f.login('stefan'),christina=await f.login('christina');
  const thread=await f.request(christina,'/api/threads',{method:'POST',body:{channelId:'channel-chat',name:'Notifications thread',firstMessage:'Initial'}});
  assert.equal(thread.status,201);
  let sent=await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'thread',targetId:thread.id,content:'Hello thread'}});assert.equal(sent.status,201);
  let inbox=await f.request(christina,'/api/notifications?workspaceId=ws-cord');assert.ok(inbox.items.some(x=>x.kind==='thread'&&x.message_id===sent.message.id));
  // Editing a message to newly mention an existing recipient upgrades the same notification.
  const edit=await f.request(stefan,`/api/messages/${sent.message.id}`,{method:'PATCH',body:{content:'Hello <@user-christina>'}});
  assert.equal(edit.status,200);
  inbox=await f.request(christina,'/api/notifications?workspaceId=ws-cord');
  const matches=inbox.items.filter(x=>x.message_id===sent.message.id);
  assert.equal(matches.length,1);assert.equal(matches[0].kind,'mention');
  const deleted=await f.request(stefan,`/api/messages/${sent.message.id}`,{method:'DELETE'});assert.equal(deleted.status,200);
  inbox=await f.request(christina,'/api/notifications?workspaceId=ws-cord');assert.equal(inbox.items.some(x=>x.message_id===sent.message.id),false);
}));

test('notification SSE is recipient-scoped, not broadcast to other workspace members',()=>use(async f=>{
  const stefan=await f.login('stefan'),christina=await f.login('christina');
  const stream=await fetch(f.base+'/api/events?workspaceId=ws-cord',{headers:{cookie:christina}});
  assert.equal(stream.status,200);
  const reader=stream.body.getReader(),decoder=new TextDecoder();
  try{
    // The subscription is active before the message is posted.
    const initial=await reader.read();assert.ok(decoder.decode(initial.value).includes('event: ready'));
    const sent=await f.request(stefan,'/api/messages',{method:'POST',body:{targetType:'channel',targetId:'channel-general',content:'Hello <@user-christina>'}});
    assert.equal(sent.status,201);
    let message='',found=false;
    const timeout=setTimeout(()=>reader.cancel().catch(()=>{}),3000);
    try{for(let n=0;n<8;n++){const p=await reader.read();if(p.done)break;message+=decoder.decode(p.value);if(message.includes('event: notification')){found=true;break}}}finally{clearTimeout(timeout)}
    assert.ok(found,'recipient should get an SSE notification');
    assert.equal(message.includes('user-stefan'),false,'SSE must not reveal actor identity in payload');
  }finally{await reader.cancel().catch(()=>{})}
}));
