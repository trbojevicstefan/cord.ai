import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentConsoleUI} from '../public/agent-console.js';

const icon=name=>`[${name}]`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const model=()=>({ok:true,generatedAt:new Date().toISOString(),sampleSize:1,stats:{total:1,queued:0,running:1,completed:0,failed:0,successRate:null},
 agents:[{id:'a',name:'OPAYA Runner',description:'My connected runtime',type:'bridge',runtime:'opaya',status:'online',model:'sonnet',paused:false,
 connection:{pending:1,device:{name:'Mac Studio',runtime:'opaya',version:'2.0',lastSeen:new Date().toISOString()}}}],
 runs:[{id:'r',agentId:'a',status:'running',progress:'Working on task',targetType:'thread',targetId:'t',createdAt:new Date().toISOString(),canCancel:true}],
 counts:{a:{total:1,queued:0,running:1,completed:0,failed:0,successRate:null}},
 pendingApprovals:[{id:'p',agentId:'a',title:'Read repo',detail:'Read-only request',createdAt:new Date().toISOString()}]});
function fixture(admin=true){
 const calls=[],messages=[],state={workspace:{id:'ws'}};
 let markup='';let ui;
 const api=async(path,opts={})=>{calls.push({path,opts});if(path.startsWith('/agent-console/runs/'))return {ok:true,run:model().runs[0],approvals:[]};if(path.startsWith('/agent-console'))return model();return {ok:true,dmId:'dm1',id:'dm1'}};
 ui=createAgentConsoleUI({api,icon,esc,getData:()=>state,isAdmin:()=>admin,
  renderOverlays:()=>{markup=ui.overlay()},toast:msg=>messages.push(msg),selectTarget:(...args)=>messages.push(args),
  openModal:(...args)=>messages.push(args),loadData:async()=>{},onError:e=>{throw e}});
 return {ui,calls,messages,html:()=>markup};
}
test('opens accessible agent dashboard and run telemetry',async()=>{
 const f=fixture();await f.ui.open('a');const html=f.html();
 assert.match(html,/Agent Control Center/);assert.match(html,/OPAYA Runner/);
 assert.match(html,/Working on task/);
 assert.match(html,/My connected runtime/);assert.match(html,/Mac Studio/);
 await f.ui.handleAction('opaya-console-tab',{dataset:{tab:'approvals'}});
 assert.match(f.html(),/Approve once/);
 assert.equal(f.calls[0].path,'/agent-console?workspaceId=ws');
});
test('dashboard reuses secured existing pause and approval endpoints',async()=>{
 const f=fixture();await f.ui.open('a');
 await f.ui.handleAction('opaya-console-pause',{dataset:{id:'a'}});
 await f.ui.handleAction('opaya-console-approval',{dataset:{id:'p',decision:'approved'}});
 assert(f.calls.some(c=>c.path==='/agent-connections/a/pause'&&c.opts.body.paused===true));
 assert(f.calls.some(c=>c.path==='/approvals/p'&&c.opts.body.decision==='approved'));
});
test('non-admin users cannot open operational telemetry',async()=>{
 const f=fixture(false);await f.ui.open();assert.equal(f.calls.length,0);assert.equal(f.ui.isOpen(),false);
 assert(f.messages.some(m=>String(m).includes('admins')));
});
test('run inspection supports back navigation and close',async()=>{
 const f=fixture();await f.ui.open('a');await f.ui.handleAction('opaya-console-run',{dataset:{id:'r'}});
 assert.match(f.html(),/Run ID/);assert.match(f.html(),/Cancel run/);
 await f.ui.handleAction('opaya-console-back',{dataset:{}});
 assert.match(f.html(),/Recent activity/);
 assert.equal(f.ui.close(),true);assert.equal(f.ui.isOpen(),false);
});
