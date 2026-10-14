import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '../server/database.mjs';
import { createOperator, operatorEndpoint } from '../server/operator.mjs';

process.env.CORD_MASTER_KEY ||= randomBytes(32).toString('hex');
process.env.CORD_DEMO='1';
const WS='ws-cord';
async function setup(fn){
  const dir=mkdtempSync(join(tmpdir(),'cord-operator-test-'));
  const store=createDatabase(join(dir,'data.sqlite'),{demo:true});
  const {get,run}=store;const user={id:'user-stefan'};const events=[];
  const service=createOperator({
    store,broadcast:(...x)=>events.push(x),audit:()=>{},
    requireWorkspace:(uid,ws)=>{if(uid!==user.id||ws!==WS)throw Object.assign(new Error('Not a member'),{status:403})},
    requireAdmin:(uid,ws)=>{if(uid!==user.id||ws!==WS)throw Object.assign(new Error('Not an admin'),{status:403})},
    bodyJSON:async req=>req.data||{},
    asJSON:(res,status,body)=>{res.status=status;res.body=body},
    recordMessage:(ws,type,id,authorType,authorId,content,meta)=>{
      const mid=randomBytes(16).toString('hex');run('INSERT INTO messages(id,workspace_id,target_type,target_id,author_type,author_id,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)',mid,ws,type,id,authorType,authorId,content,JSON.stringify(meta),new Date().toISOString());return{id:mid};
    }
  });
  async function call(path,method='GET',data={},actor=user){
    const res={};const query=method==='GET'?'?workspaceId='+WS:'';
    try{const handled=await service.api({method,data},res,new URL('http://127.0.0.1'+path+query),actor);assert.equal(handled,true);return {status:res.status,...res.body}}
    catch(e){return {status:e.status||500,error:e.message}}
  }
  try{await fn({store,get,run,user,call,events})}finally{store.close();rmSync(dir,{recursive:true,force:true})}
}
const post=(call,path,body)=>call(path,'POST',{workspaceId:WS,...body});
const patch=(call,path,body)=>call(path,'PATCH',{workspaceId:WS,...body});

test('Provider URLs use a fixed host or require allowlisting, never arbitrary local network hosts',()=>{
  assert.equal(operatorEndpoint('openai'),'https://api.openai.com/v1/chat/completions');
  assert.equal(operatorEndpoint('anthropic'),'https://api.anthropic.com/v1/messages');
  assert.throws(()=>operatorEndpoint('compatible','http://10.0.0.1:11434/v1/chat/completions'),/HTTPS/);
  assert.throws(()=>operatorEndpoint('compatible','https://example.com/v1/chat/completions'),/CORD_LLM_ALLOWED_HOSTS/);
  assert.throws(()=>operatorEndpoint('compatible','https://example.com/v1/chat/completions#bad'),/credentials/);
  assert.equal(operatorEndpoint('compatible','http://127.0.0.1:11434/v1/chat/completions'),'http://127.0.0.1:11434/v1/chat/completions');
});

test('Secrets are encrypted and scoped to the workspace; no non-admin access',async()=>setup(async({get,call})=>{
  const x=await patch(call,'/api/operator/config',{provider:'openai',model:'gpt-4.1-mini',apiKey:'sk-never-expose-me',enabled:true});
  assert.equal(x.status,200);assert.equal(x.config.hasKey,true);assert.equal(JSON.stringify(x).includes('sk-never-expose-me'),false);
  const row=get('SELECT encrypted_key FROM cord_operator_config WHERE workspace_id=?',WS);
  assert.ok(row.encrypted_key);assert.ok(!row.encrypted_key.includes('sk-never-expose-me'));
  const unprivileged=await call('/api/operator/config','GET',{}, {id:'other-user'});
  assert.equal(unprivileged.status,403);
  const wrongWorkspace=await patch(call,'/api/operator/config',{workspaceId:'foreign-ws',provider:'openai'});
  assert.equal(wrongWorkspace.status,403);
  const blocked=await patch(call,'/api/operator/config',{provider:'compatible',endpoint:'http://169.254.169.254/latest/meta-data',enabled:true});
  assert.equal(blocked.status,400);
}));

test('Disabled provider cannot execute, missing API key cannot be enabled',async()=>setup(async({call})=>{
  assert.equal((await post(call,'/api/operator/ask',{prompt:'Create a channel'})).status,409);
  assert.equal((await patch(call,'/api/operator/config',{provider:'anthropic',enabled:true})).status,400);
  assert.equal((await patch(call,'/api/operator/config',{provider:'compatible',endpoint:'',enabled:true})).status,400);
}));

test('Model reads workspace and proposes a write; approval is required and cannot be replayed',async()=>{
  let count=0;const model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(payload.tools.some(x=>x.function.name==='create_thread'));count++;
    const call=count===1?{id:'read-1',name:'workspace_overview',arguments:'{}'}:{id:'write-1',name:'create_thread',arguments:JSON.stringify({channelId:'channel-chat',name:'Sprint demo',firstMessage:'Goals for the team'})};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]}}]}));
  });
  await new Promise(ok=>model.listen(0,'127.0.0.1',ok));
  try{await setup(async({call,get})=>{
    const port=model.address().port;
    const saved=await patch(call,'/api/operator/config',{provider:'compatible',model:'test-model',endpoint:`http://127.0.0.1:${port}/v1/chat/completions`,enabled:true});
    assert.equal(saved.status,200);
    const before=get('SELECT COUNT(*) n FROM threads WHERE workspace_id=?',WS).n;
    const response=await post(call,'/api/operator/ask',{prompt:'Create a Sprint demo thread in the main channel'});
    assert.equal(response.status,200,response.error);
    assert.ok(response.approval);assert.equal(response.approval.tool,'create_thread');assert.deepEqual(response.inspected,['workspace_overview']);
    assert.equal(get('SELECT COUNT(*) n FROM threads WHERE workspace_id=?',WS).n,before,'Writes cannot execute before approval');
    const approved=await post(call,'/api/operator/approve',{approvalId:response.approval.id});
    assert.equal(approved.status,200,approved.error);assert.equal(approved.result.type,'thread');
    assert.equal(get('SELECT COUNT(*) n FROM threads WHERE workspace_id=?',WS).n,before+1);
    assert.equal((await post(call,'/api/operator/approve',{approvalId:response.approval.id})).status,409);
    const activity=await call('/api/operator/activity');
    assert.ok(activity.history.some(x=>x.kind==='execute'));
  })}finally{await new Promise(ok=>model.close(ok))}
});

test('Approvals are bound to the requesting admin and target IDs are checked again at execution',async()=>setup(async({get,run,call})=>{
  const id='approval-test',now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
  run('INSERT INTO cord_operator_approvals(id,workspace_id,user_id,tool,args,summary,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',id,WS,'user-stefan','update_channel_topic',JSON.stringify({channelId:'someone-elses-channel',description:'Nope'}),'Update channel',now,expires);
  const notFound=await post(call,'/api/operator/approve',{approvalId:id});
  assert.equal(notFound.status,404);
  assert.equal(get('SELECT status FROM cord_operator_approvals WHERE id=?',id).status,'pending');
  assert.equal((await post(call,'/api/operator/reject',{approvalId:id})).status,200);
  assert.equal((await post(call,'/api/operator/reject',{approvalId:id})).status,409);
}));

test('Private DMs are never readable from a model tool response, even with leaked IDs',async()=>{
  let requestIndex=0;
  const mock=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestIndex++;
    const calls=requestIndex===1?[{id:'bad-dm',type:'function',function:{name:'read_conversation',arguments:JSON.stringify({type:'dm',id:'dm-stefan-rwe'})}}]:[];
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?null:'Cord cannot access private direct messages.',...(calls.length?{tool_calls:calls}:{})}}]}));
  });
  await new Promise(ok=>mock.listen(0,'127.0.0.1',ok));
  try{await setup(async({call})=>{
    const port=mock.address().port;
    await patch(call,'/api/operator/config',{provider:'compatible',model:'local',endpoint:`http://127.0.0.1:${port}/v1/chat/completions`,enabled:true});
    const result=await post(call,'/api/operator/ask',{prompt:'Read this private DM dm-stefan-rwe'});
    assert.equal(result.status,200);
    assert.deepEqual(result.inspected,[]);
    assert.equal(result.approval,null);
  })}finally{await new Promise(ok=>mock.close(ok))}
});
