// Cord Agent Control Center: authenticated read-only telemetry over existing
// OPAYA/ACP/Codex/Claude bridges. This is NOT a remote OPAYA admin API.
// All mutations continue through audited, server-authorized bridge endpoints.
const error=(status,message)=>Object.assign(new Error(message),{status});
const clamp=(value,length=300)=>String(value??'').trim().slice(0,length);
const statuses=new Set(['queued','running','completed','failed','cancelled']);
const runtimes=['claude','codex','hermes','openclaw','opaya'];

export function createAgentConsole({store,bridge,requireWorkspace,requireAdmin,canReadTarget,asJSON}) {
  const {get,all}=store;
  const canInspect=(userId,row)=>canReadTarget(userId,row.target_type,row.target_id);
  const validStatus=status=>!status||status==='all'||statuses.has(status);
  const aggregate=rows=>{
    const result={total:rows.length,queued:0,running:0,completed:0,failed:0,cancelled:0,successRate:null,averageSeconds:null};
    let elapsed=0,finishedWithTiming=0;
    for(const row of rows){if(statuses.has(row.status))result[row.status]++;
      if(row.finished_at&&row.created_at){const delta=Date.parse(row.finished_at)-Date.parse(row.created_at);if(Number.isFinite(delta)&&delta>=0){elapsed+=delta;finishedWithTiming++}}
    }
    const finished=result.completed+result.failed+result.cancelled;
    if(finished)result.successRate=Math.round(result.completed/finished*100);
    if(finishedWithTiming)result.averageSeconds=Math.round(elapsed/finishedWithTiming/1000);
    return result;
  };
  const runRow=row=>({id:row.id,agentId:row.agent_id,messageId:row.message_id,targetType:row.target_type,targetId:row.target_id,
    status:row.status,error:clamp(row.error,400),progress:clamp(row.progress,350),createdAt:row.created_at,finishedAt:row.finished_at,
    leaseUntil:row.lease_until||null,replyId:row.reply_id||null,canCancel:Boolean(row.bridge_job&&['queued','running'].includes(row.status))});
  const agentRow=agent=>{
    const view=bridge.view(agent);
    const d=view.connection?.device;
    return {id:agent.id,name:clamp(agent.name,100),description:clamp(agent.description,280),type:agent.type,
      model:clamp(view.model,120),runtime:agent.type==='bridge'?clamp(view.runtime,30):null,
      status:agent.type==='demo'?'demo':clamp(view.status||'offline',40),
      paused:Boolean(view.paused),effort:clamp(view.effort,20),timeoutSeconds:view.timeout_seconds||null,
      connection:agent.type==='bridge'?{pending:Number(view.connection?.pending||0),pairingExpiresAt:view.connection?.pairing?.expires_at||null,
        device:d?{name:clamp(d.name,100),runtime:clamp(d.runtime,30),version:clamp(d.version,40),lastSeen:d.last_seen||null,revoked:Boolean(d.revoked_at)}:null}:null};
  };
  const selectRuns=(ws)=>all(`SELECT r.id,r.workspace_id,r.agent_id,r.message_id,r.target_type,r.target_id,r.status,
    r.error,r.created_at,r.finished_at,j.progress,j.lease_until,j.reply_id,
    CASE WHEN j.id IS NULL THEN 0 ELSE 1 END AS bridge_job
    FROM runs r LEFT JOIN bridge_jobs j ON j.id=r.id WHERE r.workspace_id=?
    ORDER BY r.created_at DESC,r.id DESC LIMIT 500`,ws);

  async function api(req,res,url,user){
    const path=url.pathname;
    if(!path.startsWith('/api/agent-console'))return false;
    if(req.method!=='GET')throw error(405,'Agent Control Center is read-only');
    if(path==='/api/agent-console'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));requireAdmin(user.id,ws.id);
      const filter=clamp(url.searchParams.get('status'),20).toLowerCase();
      if(!validStatus(filter))throw error(400,'Invalid run status filter');
      const allVisible=selectRuns(ws.id).filter(r=>canInspect(user.id,r)).slice(0,250);
      const agents=all(`SELECT id,name,description,type,model,status,workspace_id,avatar,color,created_at
        FROM agents WHERE workspace_id=? ORDER BY name`,ws.id).map(agentRow);
      const counts=Object.fromEntries(agents.map(a=>[a.id,aggregate(allVisible.filter(r=>r.agent_id===a.id))]));
      const pendingApprovals=bridge.approvals(user,ws.id).filter(a=>canInspect(user.id,a)).map(a=>({
        id:a.id,jobId:a.job_id,agentId:a.agent_id,title:clamp(a.title||'Tool approval',180),detail:clamp(a.detail,1000),
        createdAt:a.created_at,targetType:a.target_type,targetId:a.target_id,status:'pending'}));
      const runs=allVisible.filter(r=>!filter||filter==='all'||r.status===filter).slice(0,200).map(runRow);
      asJSON(res,200,{ok:true,agents,runs,counts,stats:aggregate(allVisible),pendingApprovals,
        sampleSize:allVisible.length,supportedRuntimes:runtimes,liveCapabilitiesReported:false,generatedAt:new Date().toISOString()});
      return true;
    }
    const match=path.match(/^\/api\/agent-console\/runs\/([a-zA-Z0-9_-]{1,100})$/);
    if(match){
      const r=get(`SELECT r.id,r.workspace_id,r.agent_id,r.message_id,r.target_type,r.target_id,r.status,
        r.error,r.created_at,r.finished_at,j.progress,j.lease_until,j.reply_id,
        CASE WHEN j.id IS NULL THEN 0 ELSE 1 END AS bridge_job
        FROM runs r LEFT JOIN bridge_jobs j ON j.id=r.id WHERE r.id=?`,match[1]);
      if(!r)throw error(404,'Run not found');
      requireWorkspace(user.id,r.workspace_id);requireAdmin(user.id,r.workspace_id);
      if(!canInspect(user.id,r))throw error(404,'Run not found');
      const approvals=all('SELECT id,title,detail,status,created_at,decided_by FROM bridge_approvals WHERE job_id=? ORDER BY created_at DESC',r.id)
        .map(a=>({id:a.id,title:clamp(a.title,180),detail:clamp(a.detail,1000),status:a.status,createdAt:a.created_at,decidedBy:a.decided_by}));
      asJSON(res,200,{ok:true,run:runRow(r),approvals});return true;
    }
    throw error(404,'Unknown Agent Control Center endpoint');
  }
  return {api};
}
