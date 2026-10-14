import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAgentConsole} from '../server/agent-console.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`
 CREATE TABLE workspaces(id TEXT PRIMARY KEY);
 CREATE TABLE memberships(workspace_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(workspace_id,user_id));
 CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,description TEXT,type TEXT,model TEXT,status TEXT,workspace_id TEXT,avatar TEXT,color TEXT,created_at TEXT,secret_encrypted TEXT);
 CREATE TABLE runs(id TEXT PRIMARY KEY,workspace_id TEXT,agent_id TEXT,message_id TEXT,target_type TEXT,target_id TEXT,status TEXT,error TEXT,created_at TEXT,finished_at TEXT);
 CREATE TABLE bridge_jobs(id TEXT PRIMARY KEY,progress TEXT,lease_until TEXT,reply_id TEXT,payload TEXT);
 CREATE TABLE bridge_approvals(id TEXT PRIMARY KEY,job_id TEXT,title TEXT,detail TEXT,status TEXT,created_at TEXT,decided_by TEXT);
 `);
 const all=(sql,...args)=>db.prepare(sql).all(...args),get=(sql,...args)=>db.prepare(sql).get(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
 run('INSERT INTO workspaces VALUES(?)','w');
 run('INSERT INTO memberships VALUES(?,?,?)','w','owner','owner');
 run('INSERT INTO memberships VALUES(?,?,?)','w','bob','member');
 run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?)','a','OPAYA Runner','Remote agent','bridge','opus','online','w','O','#55b','2026-10-01','ENCRYPTED_KEY_MUST_NOT_APPEAR');
 run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?)','d','Demo Helper','Simulated teammate','demo','','online','w','D','#66b','2026-10-01','');
 const insert=(id,type,target,status)=>run('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)',id,'w','a','message-'+id,type,target,status,status==='failed'?'Provider error':'','2026-10-15T00:00:00Z',status==='running'?null:'2026-10-15T00:00:30Z');
 insert('done','thread','visible','completed');
 insert('private','dm','private-dm','failed');
 insert('running','thread','visible','running');
 insert('cancelled','channel','visible','cancelled');
 run('INSERT INTO bridge_jobs VALUES(?,?,?,?,?)','running','Searching files','2026-10-15T00:02:00Z',null,'CONFIDENTIAL_JOB_PAYLOAD_MUST_NOT_APPEAR');
 run('INSERT INTO bridge_approvals VALUES(?,?,?,?,?,?,?)','approval','running','Read repository','Read-only tool access','pending','2026-10-15T00:00:00Z',null);
 const bridge={
  view:a=>a.type==='bridge'?{...a,runtime:'opaya',status:'online',paused:0,effort:'high',timeout_seconds:600,
    connection:{pending:1,device:{name:'My Desktop',runtime:'opaya',version:'2.2',last_seen:'2026-10-15T00:00:00Z',revoked_at:null,token_hash:'TOKEN_MUST_NOT_APPEAR'}}}:a,
  approvals:()=>[{id:'approval',job_id:'running',agent_id:'a',title:'Read repository',detail:'Read-only tool access',created_at:'2026-10-15T00:00:00Z',target_type:'thread',target_id:'visible'}]
 };
 const sent=[];
 const consoleApi=createAgentConsole({store:{get,all,run,db},bridge,
  requireWorkspace:(user,id)=>{const w=id||'w';if(!get('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?',user,w))throw Object.assign(new Error('Forbidden'),{status:403});return {id:w}},
  requireAdmin:(user,w)=>{if(get('SELECT role FROM memberships WHERE user_id=? AND workspace_id=?',user,w)?.role!=='owner')throw Object.assign(new Error('Admin required'),{status:403})},
  canReadTarget:(user,type,id)=>id==='visible',
  asJSON:(_res,status,body)=>sent.push({status,body})});
 const call=async(user,path,method='GET')=>{const handled=await consoleApi.api({method}, {},new URL('http://localhost'+path),{id:user});if(handled===false)return null;return sent.pop()?.body};
 return {call,db,run};
}

async function withFixture(fn){const f=fixture();try{return await fn(f)}finally{f.db.close()}}

test('admin sees sanitized OPAYA agent health and workspace runs',()=>withFixture(f=>{
 const x=f.call('owner','/api/agent-console?workspaceId=w');return x.then(result=>{
  assert.equal(result.ok,true);assert.equal(result.agents.length,2);
  const a=result.agents.find(x=>x.id==='a');assert.equal(a.runtime,'opaya');
  assert.equal(a.connection.device.runtime,'opaya');assert.equal(a.connection.pending,1);
  assert.equal(result.agents.find(x=>x.id==='d').status,'demo');
  assert.equal(result.runs.length,3);assert.equal(result.stats.total,3);
  assert.equal(result.stats.completed,1);assert.equal(result.stats.running,1);assert.equal(result.stats.cancelled,1);
  assert.equal(result.stats.successRate,50);assert.equal(result.counts.a.total,3);
  assert.equal(result.liveCapabilitiesReported,false);assert.deepEqual(result.supportedRuntimes,['claude','codex','hermes','openclaw','opaya']);
  assert.equal(result.pendingApprovals.length,1);
  assert.doesNotMatch(JSON.stringify(result),/ENCRYPTED_KEY_MUST_NOT_APPEAR|TOKEN_MUST_NOT_APPEAR|CONFIDENTIAL_JOB_PAYLOAD_MUST_NOT_APPEAR|private-dm/);
 });
}));

test('list/status filtering and detailed run inspection',()=>withFixture(async f=>{
 const x=await f.call('owner','/api/agent-console?workspaceId=w&status=running');
 assert.deepEqual(x.runs.map(r=>r.id),['running']);
 assert.equal(x.runs[0].canCancel,true);
 const r=await f.call('owner','/api/agent-console/runs/running');assert.equal(r.run.status,'running');
 assert.equal(r.run.progress,'Searching files');assert.equal(r.approvals.length,1);
 assert.doesNotMatch(JSON.stringify(r),/CONFIDENTIAL_JOB_PAYLOAD_MUST_NOT_APPEAR/);
 await assert.rejects(f.call('owner','/api/agent-console?workspaceId=w&status=unsupported'),{status:400});
}));

test('member and missing workspace are denied; DM run is never exposed',()=>withFixture(async f=>{
 await assert.rejects(f.call('bob','/api/agent-console?workspaceId=w'),{status:403});
 await assert.rejects(f.call('owner','/api/agent-console?workspaceId=other'),{status:403});
 await assert.rejects(f.call('owner','/api/agent-console/runs/private'),{status:404});
 await assert.rejects(f.call('bob','/api/agent-console/runs/running'),{status:403});
 await assert.rejects(f.call('owner','/api/agent-console/runs/missing'),{status:404});
}));

test('console endpoints are read-only and out-of-scope routes are ignored',()=>withFixture(async f=>{
 await assert.rejects(f.call('owner','/api/agent-console?workspaceId=w','POST'),{status:405});
 await assert.rejects(f.call('owner','/api/agent-console/runs/running','DELETE'),{status:405});
 assert.equal(await f.call('owner','/api/runs'),null);
}));
