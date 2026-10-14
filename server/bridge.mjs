import { randomBytes, createHash } from 'node:crypto';
import { uid, now } from './database.mjs';

export const RUNTIMES=['claude','codex','hermes','openclaw','opaya'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(s,n=500)=>String(s??'').trim().slice(0,n);
const active=['queued','running'];
export function createBridge({store,broadcast,recordMessage,audit,requireWorkspace,requireAdmin,canReadTarget,bodyJSON,asJSON}){
  const {db,get,all,run}=store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, runtime TEXT NOT NULL, instructions TEXT DEFAULT '', effort TEXT DEFAULT '', timeout_seconds INTEGER DEFAULT 600, paused INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bridge_pairings(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, token_hash TEXT UNIQUE, expires_at TEXT NOT NULL, claimed_at TEXT);
    CREATE TABLE IF NOT EXISTS bridge_devices(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, token_hash TEXT UNIQUE, name TEXT, runtime TEXT, version TEXT, last_seen TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS bridge_jobs(id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, payload TEXT NOT NULL, device_id TEXT, lease_until TEXT, progress TEXT DEFAULT '', reply_id TEXT);
    CREATE TABLE IF NOT EXISTS bridge_approvals(id TEXT PRIMARY KEY, job_id TEXT REFERENCES bridge_jobs(id) ON DELETE CASCADE, title TEXT, detail TEXT, status TEXT DEFAULT 'pending', created_at TEXT, decided_by TEXT);
  `);
  function emit(agentId){const a=get('SELECT workspace_id FROM agents WHERE id=?',agentId);if(a)broadcast(a.workspace_id);}
  function event(job,status,error=''){
    broadcast(job.workspace_id,'agent',{agentId:job.agent_id,runId:job.id,targetType:job.target_type,targetId:job.target_id,status,error},job.target_type==='dm'?job.target_id:null);
  }
  function finish(job,status,error=''){
    run('UPDATE runs SET status=?,error=?,finished_at=? WHERE id=? AND status IN (?,?)',status,error,now(),job.id,...active);
    run("UPDATE bridge_approvals SET status='declined' WHERE job_id=? AND status='pending'",job.id);
    event(job,status,error);emit(job.agent_id);
  }
  function sweep(){
    const date=now();
    for(const job of all("SELECT r.* FROM runs r JOIN bridge_jobs j ON j.id=r.id WHERE r.status='running' AND j.lease_until<?",date))finish(job,'failed','Bridge disconnected during execution. Check the local runtime before retrying.');
    for(const job of all("SELECT r.* FROM runs r JOIN bridge_jobs j ON j.id=r.id WHERE r.status='queued' AND r.created_at<?",new Date(Date.now()-24*3600_000).toISOString()))finish(job,'failed','Agent did not connect within 24 hours.');
  }
  const sweepTimer=setInterval(sweep,10_000);sweepTimer.unref();
  function view(agent){
    const config=get('SELECT * FROM agent_settings WHERE agent_id=?',agent.id);
    if(!config)return agent;
    const device=get('SELECT id,name,runtime,version,last_seen,revoked_at FROM bridge_devices WHERE agent_id=? ORDER BY last_seen DESC LIMIT 1',agent.id);
    const online=device&&!device.revoked_at&&Date.now()-Date.parse(device.last_seen)<35_000;
    const pairing=get('SELECT id,expires_at,claimed_at FROM bridge_pairings WHERE agent_id=? ORDER BY expires_at DESC LIMIT 1',agent.id);
    return {...agent,...config,id:agent.id,status:config.paused?'paused':online?'online':device?.revoked_at?'disconnected':device?'offline':pairing?.expires_at>now()?'pairing':'offline',connection:{device,pairing,pending:get("SELECT COUNT(*) AS n FROM runs WHERE agent_id=? AND status IN ('queued','running')",agent.id).n}};
  }
  function enqueue(source,agent,history){
    const config=get('SELECT * FROM agent_settings WHERE agent_id=?',agent.id);
    if(!config||config.paused)return;
    if(get('SELECT id FROM runs WHERE agent_id=? AND message_id=?',agent.id,source.id))return;
    const id=uid();
    const payload={id,agentId:agent.id,workspaceId:agent.workspace_id,sessionId:`${agent.workspace_id}:${source.target_type}:${source.target_id}`,targetType:source.target_type,targetId:source.target_id,messageId:source.id,message:source.content,messages:history.map(m=>({id:m.id,role:m.author_type==='agent'?'assistant':'user',content:m.content})),settings:{model:agent.model,instructions:config.instructions,effort:config.effort,timeoutSeconds:config.timeout_seconds}};
    db.exec('BEGIN IMMEDIATE');try{
      run('INSERT INTO runs(id,workspace_id,agent_id,message_id,target_type,target_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',id,agent.workspace_id,agent.id,source.id,source.target_type,source.target_id,'queued',now());
      run('INSERT INTO bridge_jobs(id,agent_id,payload) VALUES(?,?,?)',id,agent.id,JSON.stringify(payload));db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    event({...source,id,agent_id:agent.id},'queued');emit(agent.id);
    return id;
  }
  function device(req){
    const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
    const d=token&&get('SELECT * FROM bridge_devices WHERE token_hash=? AND revoked_at IS NULL',hash(token));
    if(!d)throw fail(401,'Bridge access expired or revoked. Generate a new connection prompt.');
    run('UPDATE bridge_devices SET last_seen=? WHERE id=?',now(),d.id);
    return d;
  }
  function ownedJob(d,id){const job=get('SELECT r.*,j.device_id,j.payload FROM runs r JOIN bridge_jobs j ON j.id=r.id WHERE r.id=? AND j.agent_id=? AND j.device_id=?',id,d.agent_id,d.id);if(!job)throw fail(404,'Run not found');return job;}
  async function worker(req,res,url){
    if(!url.pathname.startsWith('/api/bridge/'))return false;
    const path=url.pathname;
    if(path==='/api/bridge/enroll'&&req.method==='POST'){
      const input=await bodyJSON(req),p=get('SELECT * FROM bridge_pairings WHERE token_hash=? AND claimed_at IS NULL AND expires_at>?',hash(text(input.code,150)),now());
      if(!p)throw fail(401,'Pairing code is invalid, expired or already used.');
      const config=get('SELECT * FROM agent_settings WHERE agent_id=?',p.agent_id);
      if(config.runtime!=='opaya'&&config.runtime!==input.runtime)throw fail(400,'This prompt is for a different runtime.');
      const id=uid(),token=randomBytes(32).toString('hex');
      run('UPDATE bridge_pairings SET claimed_at=? WHERE id=?',now(),p.id);
      run('UPDATE bridge_devices SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL',now(),p.agent_id);
      for(const job of all("SELECT * FROM runs WHERE agent_id=? AND status='running'",p.agent_id))finish(job,'cancelled','The agent was paired to a new bridge. Check the old runtime before retrying.');
      run('INSERT INTO bridge_devices(id,agent_id,token_hash,name,runtime,version,last_seen) VALUES(?,?,?,?,?,?,?)',id,p.agent_id,hash(token),text(input.deviceName,100)||'Agent computer',text(input.runtime,30),text(input.version,40),now());
      run('UPDATE agents SET status=? WHERE id=?','online',p.agent_id);emit(p.agent_id);
      asJSON(res,201,{ok:true,agentId:p.agent_id,deviceId:id,token});return true;
    }
    const d=device(req);sweep();
    if(path==='/api/bridge/poll'&&req.method==='POST'){
      const config=get('SELECT * FROM agent_settings WHERE agent_id=?',d.agent_id);
      const running=get("SELECT id FROM runs WHERE agent_id=? AND status='running'",d.agent_id);
      let job=null;
      if(!config.paused&&!running){
        const row=get("SELECT r.id,j.payload FROM runs r JOIN bridge_jobs j ON j.id=r.id WHERE r.agent_id=? AND r.status='queued' ORDER BY r.rowid LIMIT 1",d.agent_id);
        if(row){
          run('UPDATE runs SET status=? WHERE id=?','running',row.id);
          run('UPDATE bridge_jobs SET device_id=?,lease_until=? WHERE id=?',d.id,new Date(Date.now()+45_000).toISOString(),row.id);
          job=JSON.parse(row.payload);event(get('SELECT * FROM runs WHERE id=?',row.id),'running');emit(d.agent_id);
        }
      }
      asJSON(res,200,{ok:true,job,paused:!!config.paused});return true;
    }
    if(path==='/api/bridge/disconnect'&&req.method==='POST'){
      run('UPDATE bridge_devices SET last_seen=? WHERE id=?',new Date(0).toISOString(),d.id);emit(d.agent_id);asJSON(res,200,{ok:true});return true;
    }
    const match=path.match(/^\/api\/bridge\/jobs\/([^/]+)\/(heartbeat|complete|approval|approval-status)$/);
    if(!match)throw fail(404,'Bridge endpoint not found');
    let job=ownedJob(d,match[1]);const action=match[2];
    if(action==='approval-status'&&req.method==='GET'){
      asJSON(res,200,{ok:true,status:job.status,approvals:all('SELECT id,status FROM bridge_approvals WHERE job_id=?',job.id)});return true;
    }
    if(req.method!=='POST')throw fail(405,'Method not allowed');
    const input=await bodyJSON(req);
    device(req);job=ownedJob(d,match[1]);
    if(action==='heartbeat'){
      if(job.status==='running'){
        run('UPDATE bridge_jobs SET lease_until=?,progress=? WHERE id=?',new Date(Date.now()+45_000).toISOString(),text(input.progress,350),job.id);
        broadcast(job.workspace_id,'progress',{runId:job.id,progress:text(input.progress,350)},job.target_type==='dm'?job.target_id:null);
      }
      asJSON(res,200,{ok:true,status:job.status});return true;
    }
    if(action==='approval'){
      if(job.status!=='running')throw fail(409,'Run is no longer active');
      const id=uid();run('INSERT INTO bridge_approvals(id,job_id,title,detail,created_at) VALUES(?,?,?,?,?)',id,job.id,text(input.title,200),text(input.detail,5000),now());broadcast(job.workspace_id,'agent-approval',{approvalId:id,runId:job.id,targetType:job.target_type,targetId:job.target_id},job.target_type==='dm'?job.target_id:null);emit(d.agent_id);
      asJSON(res,201,{ok:true,id});return true;
    }
    if(action==='complete'){
      if(job.status==='completed'){asJSON(res,200,{ok:true,status:job.status});return true;}
      if(job.status!=='running')throw fail(409,'Run has ended; late output was ignored');
      if(input.error){finish(job,'failed',text(input.error,500));asJSON(res,200,{ok:true});return true;}
      const reply=text(input.reply,24000);if(!reply)throw fail(400,'Agent returned no text');
      const target=get(`SELECT id FROM ${job.target_type==='channel'?'channels':job.target_type==='thread'?'threads':'dms'} WHERE id=?`,job.target_id);
      if(!target){finish(job,'cancelled','Conversation was deleted');asJSON(res,200,{ok:true});return true;}
      db.exec('BEGIN IMMEDIATE');try{
        const m=recordMessage(job.workspace_id,job.target_type,job.target_id,'agent',job.agent_id,reply,{run_id:job.id});
        run('UPDATE bridge_jobs SET reply_id=? WHERE id=?',m.id,job.id);finish(job,'completed');db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      asJSON(res,200,{ok:true});return true;
    }
    return false;
  }
  function origin(req){
    const base=process.env.CORD_PUBLIC_ORIGIN||`http://${req.headers.host}`;
    const url=new URL(base);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!/^[a-z0-9.:[\]-]+$/i.test(url.hostname))throw fail(400,'Invalid public origin');
    return url.origin;
  }
  async function api(req,res,url,user){
    const path=url.pathname;
    if(path==='/api/agent-connections'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);
      const runtime=text(input.runtime,30);if(!RUNTIMES.includes(runtime))throw fail(400,'Unknown runtime');
      let id=input.agentId;
      if(id){const a=get('SELECT * FROM agents WHERE id=? AND workspace_id=?',id,ws.id);if(!a||a.type!=='bridge')throw fail(404,'Bridge agent not found');}
      else{
        const name=text(input.name,65)||({claude:'Claude Code',codex:'Codex',hermes:'Hermes',openclaw:'OpenClaw',opaya:'OPAYA Agent'}[runtime]);id=uid();
        run('INSERT INTO agents(id,workspace_id,name,avatar,color,description,type,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,ws.id,name,name.slice(0,2).toUpperCase(),'#73a7e6',text(input.description,500),'bridge','pairing',now());
        run('INSERT INTO agent_settings(agent_id,runtime) VALUES(?,?)',id,runtime);
      }
      const code=randomBytes(24).toString('hex'),pairId=uid(),expiresAt=new Date(Date.now()+15*60_000).toISOString();
      run('DELETE FROM bridge_pairings WHERE agent_id=?',id);
      run('INSERT INTO bridge_pairings(id,agent_id,token_hash,expires_at) VALUES(?,?,?,?)',pairId,id,hash(code),expiresAt);
      const base=origin(req),selected=get('SELECT runtime FROM agent_settings WHERE agent_id=?',id).runtime;
      const prompt=`Connect this agent to my Cord AI workspace at ${base}.\nDownload ${base}/bridge/install.mjs to a temporary file named cord-install.mjs using your HTTP/file tools, then run it with Node.js 22.13 or newer:\n\nnode cord-install.mjs --server ${base} --pair ${code} --runtime ${selected}\n\nRun this from the project directory you want the agent to work in. The installer uses this machine's existing agent login, pairs once, and starts a background bridge. Do not put credentials in chat or commit them. Do not enable bypass permissions. If using OPAYA, auto-discover a compatible agent (or select one with --opaya-agent ID). Report the connection result and the local status command. If the CLI is missing or not signed in, report that setup step instead of claiming success. This pairing code expires at ${expiresAt}.`;
      audit(user.id,ws.id,'agent.pair','agent',id,{runtime:selected});emit(id);
      asJSON(res,201,{ok:true,agentId:id,pairingId:pairId,expiresAt,prompt});return true;
    }
    const route=path.match(/^\/api\/agent-connections\/([^/]+)(?:\/(settings|revoke|pause|test))?$/);
    if(route){
      const a=get('SELECT * FROM agents WHERE id=?',route[1]);if(!a)throw fail(404,'Agent not found');requireWorkspace(user.id,a.workspace_id);requireAdmin(user.id,a.workspace_id);
      if(a.type!=='bridge')throw fail(400,'This is not a paired agent');
      const action=route[2];
      if(req.method==='GET'&&!action){asJSON(res,200,{ok:true,agent:view(a)});return true;}
      if(req.method!=='POST'&&req.method!=='PATCH')throw fail(405,'Method not allowed');
      const input=await bodyJSON(req);
      if(action==='settings'){
        const config=get('SELECT * FROM agent_settings WHERE agent_id=?',a.id);
        const timeout=Number(input.timeoutSeconds??config.timeout_seconds);if(!Number.isInteger(timeout)||timeout<30||timeout>1800)throw fail(400,'Timeout must be 30–1800 seconds');
        const effort=text(input.effort??config.effort,20);if(!['','minimal','low','medium','high','xhigh','max'].includes(effort))throw fail(400,'Unknown reasoning effort');
        const name=text(input.name??a.name,65);if(name.length<2)throw fail(400,'Agent name must have at least two characters');
        run('UPDATE agents SET name=?,description=?,model=? WHERE id=?',name,text(input.description??a.description,500),text(input.model??a.model,120),a.id);
        run('UPDATE agent_settings SET instructions=?,effort=?,timeout_seconds=? WHERE agent_id=?',text(input.instructions??config.instructions,6000),effort,timeout,a.id);
      }else if(action==='pause')run('UPDATE agent_settings SET paused=? WHERE agent_id=?',input.paused?1:0,a.id);
      else if(action==='revoke'){
        run('UPDATE bridge_devices SET revoked_at=? WHERE agent_id=?',now(),a.id);run('DELETE FROM bridge_pairings WHERE agent_id=?',a.id);
        for(const job of all("SELECT * FROM runs WHERE agent_id=? AND status IN ('queued','running')",a.id))finish(job,'cancelled','Agent access revoked');
      }else if(action==='test'){
        let dm=get('SELECT * FROM dms WHERE user_id=? AND participant_agent_id=?',user.id,a.id);
        if(!dm){const id=uid();run('INSERT INTO dms(id,workspace_id,user_id,participant_agent_id,created_at) VALUES(?,?,?,?,?)',id,a.workspace_id,user.id,a.id,now());dm={id};}
        const m=recordMessage(a.workspace_id,'dm',dm.id,'user',user.id,'Connection check: reply with a short greeting and identify your runtime.');enqueue(m,a,[m]);
        asJSON(res,201,{ok:true,dmId:dm.id});return true;
      }else throw fail(404,'Unknown connection action');
      audit(user.id,a.workspace_id,`agent.${action}`,'agent',a.id);emit(a.id);asJSON(res,200,{ok:true});return true;
    }
    const jobRoute=path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if(jobRoute&&req.method==='POST'){
      const job=get('SELECT * FROM runs WHERE id=?',jobRoute[1]);if(!job)throw fail(404,'Run not found');requireWorkspace(user.id,job.workspace_id);
      if(!canReadTarget(user.id,job.target_type,job.target_id))throw fail(403,'Conversation access required');
      if(!get('SELECT id FROM bridge_jobs WHERE id=?',job.id))throw fail(400,'Only paired-agent runs can be cancelled here');
      if(active.includes(job.status))finish(job,'cancelled','Cancelled by a team member');asJSON(res,200,{ok:true});return true;
    }
    const approvalRoute=path.match(/^\/api\/approvals\/([^/]+)$/);
    if(approvalRoute&&req.method==='POST'){
      const approval=get('SELECT p.*,r.workspace_id,r.target_type,r.target_id FROM bridge_approvals p JOIN runs r ON r.id=p.job_id WHERE p.id=?',approvalRoute[1]);if(!approval)throw fail(404,'Approval not found');
      requireAdmin(user.id,approval.workspace_id);if(!canReadTarget(user.id,approval.target_type,approval.target_id))throw fail(403,'Conversation access required');
      const input=await bodyJSON(req);if(!['approved','declined'].includes(input.decision))throw fail(400,'Unknown decision');
      run("UPDATE bridge_approvals SET status=?,decided_by=? WHERE id=? AND status='pending'",input.decision,user.id,approval.id);audit(user.id,approval.workspace_id,'agent.approval','run',approval.job_id,{decision:input.decision});broadcast(approval.workspace_id);asJSON(res,200,{ok:true});return true;
    }
    return false;
  }
  function approvals(user,ws){return all("SELECT p.*,r.agent_id,r.target_type,r.target_id FROM bridge_approvals p JOIN runs r ON r.id=p.job_id WHERE r.workspace_id=? AND p.status='pending' AND r.status='running'",ws).filter(p=>canReadTarget(user.id,p.target_type,p.target_id));}
  return {worker,api,enqueue,view,approvals,close:()=>clearInterval(sweepTimer)};
}
