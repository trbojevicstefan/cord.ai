import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, uid, now } from '../server/database.mjs';
import { createNotifications } from '../server/notifications.mjs';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'cord-notification-core-'));
  const store=createDatabase(join(directory,'cord.sqlite'),{demo:true});
  store.db.exec(`CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY,settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_approvals(id TEXT PRIMARY KEY,title TEXT);`);
  const sent=[];
  const member=(who,ws)=>!!store.get('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?',who,ws);
  const allowed=(who,type,id)=>{
    if(type==='dm') {const dm=store.get('SELECT * FROM dms WHERE id=?',id);return !!(dm&&member(who,dm.workspace_id)&&(dm.user_id===who||dm.participant_user_id===who))}
    const table=type==='channel'?'channels':type==='thread'?'threads':null;
    if(!table)return false;
    const row=store.get(`SELECT workspace_id FROM ${table} WHERE id=?`,id);return !!row&&member(who,row.workspace_id);
  };
  const notifications=createNotifications({store,canReadTarget:allowed,requireWorkspace:(who,id)=>{if(!member(who,id||'ws-cord'))throw Object.assign(new Error('Forbidden'),{status:403});return store.get('SELECT * FROM workspaces WHERE id=?',id||'ws-cord')},bodyJSON:async req=>req.payload||{},asJSON:(res,status,data)=>{res.status=status;res.body=data},sendUser:(user,ws,payload)=>sent.push({user,ws,payload})});
  function message(authorType,authorId,targetType,targetId,content){
    const value={id:uid(),workspace_id:'ws-cord',target_type:targetType,target_id:targetId,author_type:authorType,author_id:authorId,content,created_at:now()};
    store.run('INSERT INTO messages(id,workspace_id,target_type,target_id,author_type,author_id,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)',value.id,value.workspace_id,targetType,targetId,authorType,authorId,content,'{}',value.created_at);
    return value;
  }
  return {store,sent,notifications,message,async call(who,path,method='GET',payload={}){const url=new URL('http://localhost'+path);const response={};try{await notifications.api({method,payload},response,url,{id:who})}catch(error){response.status=error.status||500;response.body={ok:false,error:error.message}}return response},close(){store.close();rmSync(directory,{recursive:true,force:true})}};
}

test('mention, thread follower, DM and reply priority; unique notifications per message',t=>{
  const f=fixture();t.after(()=>f.close());const {notifications:n,store:s}=f;
  const m=f.message('user','user-stefan','channel','channel-general','Hello <@user-christina>');
  assert.equal(n.onMessage(m,{mentions:['user-christina']}),1);
  assert.equal(n.onMessage(m,{mentions:['user-christina']}),0);
  assert.equal(n.summary('user-christina','ws-cord').unread,1);
  assert.equal(n.summary('user-rob','ws-cord').unread,0);
  const th=f.message('user','user-christina','thread','thread-roadmap','A threaded update');
  assert.equal(n.onMessage(th),1);assert.equal(n.summary('user-stefan','ws-cord').unread,1);
  // An explicit reply should win over generic followed-thread activity.
  const reply=f.message('user','user-christina','thread','thread-roadmap','Answer');
  n.onMessage(reply,{replyTo:th.id}); // author of original is same sender, so not a self alert
  assert.ok(s.get('SELECT 1 FROM notifications WHERE message_id=? AND kind=?',reply.id,'thread'));
  s.run('INSERT INTO dms(id,workspace_id,user_id,participant_user_id,created_at) VALUES(?,?,?,?,?)','dm-test-notify','ws-cord','user-stefan','user-christina',now());
  const dm=f.message('user','user-stefan','dm','dm-test-notify','DM');
  assert.equal(n.onMessage(dm),1);const result=s.get('SELECT user_id,kind FROM notifications WHERE message_id=?',dm.id);
  assert.equal(result.user_id,'user-christina');assert.equal(result.kind,'dm');
});

test('muted channel/category and personal notification switches work',t=>{
  const f=fixture();t.after(()=>f.close());const {notifications:n,store:s}=f;
  s.run('INSERT INTO preferences(user_id,target_type,target_id,muted,notification_level) VALUES(?,?,?,?,?)','user-christina','category','cat-team',1,'all');
  assert.equal(n.onMessage(f.message('user','user-stefan','channel','channel-general','Muted'),{mentions:['user-christina']}),0);
  s.run('UPDATE preferences SET muted=0 WHERE user_id=?','user-christina');
  s.run('INSERT INTO user_settings(user_id,settings) VALUES(?,?)','user-christina',JSON.stringify({notifyMentions:false}));
  assert.equal(n.onMessage(f.message('user','user-stefan','channel','channel-general','Mention blocked'),{mentions:['user-christina']}),0);
  s.run('UPDATE user_settings SET settings=? WHERE user_id=?',JSON.stringify({notifyMentions:true}),'user-christina');
  const m=f.message('user','user-stefan','channel','channel-general','Allowed');
  assert.equal(n.onMessage(m,{mentions:['user-christina']}),1);
});

test('edited mention upgrades one existing thread event to mention, never duplicates it',t=>{
  const f=fixture();t.after(()=>f.close());const {notifications:n,store:s}=f;
  const m=f.message('user','user-stefan','thread','thread-roadmap','Hello');
  s.run('INSERT INTO thread_members(thread_id,user_id) VALUES(?,?)','thread-roadmap','user-christina');
  n.onMessage(m);
  const prior=s.get('SELECT kind,id FROM notifications WHERE user_id=? AND message_id=?','user-christina',m.id);
  assert.equal(prior.kind,'thread');
  s.run('CREATE TABLE IF NOT EXISTS message_mentions(message_id TEXT,user_id TEXT)');
  s.run('INSERT INTO message_mentions(message_id,user_id) VALUES(?,?)',m.id,'user-christina');
  assert.equal(n.onEditedMentions({...m,content:'Hi <@user-christina>'},[]),1);
  const out=s.get('SELECT id,kind FROM notifications WHERE user_id=? AND message_id=?','user-christina',m.id);
  assert.equal(out.id,prior.id);assert.equal(out.kind,'mention');
  assert.equal(n.onEditedMentions(m,['user-christina']),0);
});

test('read, pagination, dismiss, and permission isolation',async t=>{
  const f=fixture();t.after(()=>f.close());const {notifications:n,store:s}=f;
  const a=f.message('user','user-stefan','channel','channel-general','A');n.onMessage(a,{mentions:['user-christina']});
  const b=f.message('user','user-stefan','channel','channel-general','B');n.onMessage(b,{mentions:['user-christina']});
  let r=await f.call('user-christina','/api/notifications?workspaceId=ws-cord');assert.equal(r.body.items.length,2);assert.equal(r.body.summary.unread,2);
  const first=r.body.items[0].id;
  assert.equal((await f.call('user-rob',`/api/notifications/${first}`,'PATCH',{workspaceId:'ws-cord',read:true})).status,404);
  assert.equal((await f.call('user-christina',`/api/notifications/${first}`,'PATCH',{workspaceId:'ws-cord',read:true})).status,200);
  r=await f.call('user-christina','/api/notifications?workspaceId=ws-cord&filter=unread');assert.equal(r.body.items.length,1);
  n.markTarget('user-christina','ws-cord','channel','channel-general');assert.equal(n.summary('user-christina','ws-cord').unread,0);
  const gone=(await f.call('user-christina',`/api/notifications/${first}`,'DELETE',{workspaceId:'ws-cord'})).body;assert.equal(gone.ok,true);
  assert.equal(s.get('SELECT dismissed_at FROM notifications WHERE id=?',first).dismissed_at!=null,true);
  const n1=f.message('user','user-stefan','channel','channel-general','deleted');n.onMessage(n1,{mentions:['user-christina']});n.purgeMessage(n1.id);
  assert.equal(s.get('SELECT id FROM notifications WHERE message_id=?',n1.id),undefined);
});

test('agent errors and pending approvals notify only authorized users',t=>{
  const f=fixture();t.after(()=>f.close());const {notifications:n,store:s}=f;
  const source=f.message('user','user-stefan','thread','thread-roadmap','@agent do task');
  const runId=uid();s.run('INSERT INTO runs(id,workspace_id,agent_id,message_id,target_type,target_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',runId,'ws-cord','agent-rwe',source.id,'thread','thread-roadmap','failed',now());
  assert.equal(n.onAgentEvent('ws-cord',{runId,status:'failed',error:'Model unavailable'}),1);
  assert.equal(n.onAgentEvent('ws-cord',{runId,status:'failed',error:'Model unavailable'}),0);
  assert.equal(n.summary('user-stefan','ws-cord').agents,1);
  const approvalId=uid();s.run('INSERT INTO bridge_approvals(id,title) VALUES(?,?)',approvalId,'Run shell command');
  assert.equal(n.onApproval('ws-cord',{approvalId,runId,targetType:'thread',targetId:'thread-roadmap'}),2);
  assert.equal(n.summary('user-christina','ws-cord').agents,1);
  assert.equal(n.summary('user-rob','ws-cord').agents,0);
});
