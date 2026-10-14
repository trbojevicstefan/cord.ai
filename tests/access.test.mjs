import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAccess} from '../server/access.mjs';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,username TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE memberships(user_id TEXT,workspace_id TEXT,role TEXT,PRIMARY KEY(user_id,workspace_id));
    CREATE TABLE categories(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE channels(id TEXT PRIMARY KEY,workspace_id TEXT,category_id TEXT);
  `);
  const get=(q,...args)=>db.prepare(q).get(...args);
  const all=(q,...args)=>db.prepare(q).all(...args);
  const run=(q,...args)=>db.prepare(q).run(...args);
  for(const id of ['owner','bob','carol','stranger'])run('INSERT INTO users VALUES(?,?,?)',id,id,id);
  for(const id of ['w1','w2'])run('INSERT INTO workspaces VALUES(?)',id);
  for(const [u,w,role] of [['owner','w1','owner'],['bob','w1','member'],['carol','w1','member'],['stranger','w2','owner']])run('INSERT INTO memberships VALUES(?,?,?)',u,w,role);
  for(const [id,w] of [['cat','w1'],['othercat','w2']])run('INSERT INTO categories VALUES(?,?)',id,w);
  for(const [id,w,c] of [['general','w1','cat'],['private','w1','cat'],['foreign','w2','othercat']])run('INSERT INTO channels VALUES(?,?,?)',id,w,c);
  const sent=[];
  const access=createAccess({store:{db,get,all,run},requireWorkspace:(user,id)=>{
    const ws=id||'w1';if(!get('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?',user,ws))throw Object.assign(new Error('Forbidden'),{status:403});return {id:ws};
  },requireAdmin:(user,ws)=>{if(get('SELECT role FROM memberships WHERE user_id=? AND workspace_id=?',user,ws)?.role!=='owner')throw Object.assign(new Error('Forbidden'),{status:403})},audit:()=>{},broadcast:()=>{},bodyJSON:async req=>req.input||{},asJSON:(_,status,data)=>sent.push({status,data})});
  const call=async(user,path,method='GET',input={},query='')=>{const req={method,input},url=new URL('http://localhost'+path+query);await access.api(req,{},url,{id:user});return sent.pop()};
  return {db,get,all,run,access,call};
}

test('category deny, channel allow and explicit member override apply in the correct order',async()=>{
  const {db,access,call}=fixture();
  assert.equal(access.allowed('bob','private'),true);
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'category',scopeId:'cat',subjectType:'everyone',canView:0,canPost:0});
  assert.equal(access.allowed('bob','general'),false);
  assert.equal(access.allowed('owner','general'),true);
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'user',subjectId:'bob',canView:1,canPost:1});
  assert.equal(access.allowed('bob','private'),true);
  assert.equal(access.allowed('bob','private','post'),true);
  assert.equal(access.allowed('carol','private'),false);
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'user',subjectId:'bob',canView:1,canPost:0});
  assert.equal(access.allowed('bob','private'),true);
  assert.equal(access.allowed('bob','private','post'),false);
  db.close();
});

test('role grants, deny-first conflict, user override, role revocation',async()=>{
  const {db,access,call}=fixture();
  const role1=(await call('owner','/api/access/roles','POST',{workspaceId:'w1',name:'Design',color:'#aabbcc'})).data.id;
  const role2=(await call('owner','/api/access/roles','POST',{workspaceId:'w1',name:'Restricted'})).data.id;
  await call('owner',`/api/access/roles/${role1}/members`,'POST',{userId:'bob',enabled:true});
  await call('owner',`/api/access/roles/${role2}/members`,'POST',{userId:'bob',enabled:true});
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'everyone',canView:0,canPost:0});
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'role',subjectId:role1,canView:1,canPost:1});
  assert.equal(access.allowed('bob','private'),true);
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'role',subjectId:role2,canView:0,canPost:0});
  assert.equal(access.allowed('bob','private'),false);
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'private',subjectType:'user',subjectId:'bob',canView:1,canPost:1});
  assert.equal(access.allowed('bob','private','post'),true);
  await call('owner',`/api/access/roles/${role1}`,'DELETE');
  const result=await call('owner','/api/access?workspaceId=w1');
  assert.equal(result.data.roles.length,1);
  db.close();
});

test('non-admins and foreign workspaces cannot edit permissions or read ACL membership',async()=>{
  const {db,call,access}=fixture();
  await assert.rejects(call('bob','/api/access?workspaceId=w1'),{status:403});
  await assert.rejects(call('stranger','/api/access/overrides','POST',{workspaceId:'w2',scopeType:'channel',scopeId:'private',subjectType:'everyone',canView:0,canPost:0}),{status:404});
  await assert.rejects(call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'general',subjectType:'user',subjectId:'stranger',canView:1,canPost:1}),{status:404});
  await assert.rejects(call('bob','/api/access/roles','POST',{workspaceId:'w1',name:'Other'}),{status:403});
  await assert.rejects(call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'general',subjectType:'everyone',canView:'1',canPost:0}),{status:400});
  assert.equal(access.allowed('bob','foreign'),false);
  db.close();
});

test('role creation is unique per workspace and an override can be removed',async()=>{
  const {db,access,call}=fixture();
  await call('owner','/api/access/roles','POST',{workspaceId:'w1',name:'Engineering'});
  await assert.rejects(call('owner','/api/access/roles','POST',{workspaceId:'w1',name:'engineering'}),{status:409});
  await call('owner','/api/access/overrides','POST',{workspaceId:'w1',scopeType:'channel',scopeId:'general',subjectType:'everyone',canView:0,canPost:0});
  assert.equal(access.allowed('bob','general'),false);
  await call('owner','/api/access/overrides','DELETE',{workspaceId:'w1',scopeType:'channel',scopeId:'general',subjectType:'everyone'});
  assert.equal(access.allowed('bob','general'),true);
  db.close();
});
