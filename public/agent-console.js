// Cord Agent Control Center: live, scoped bridge telemetry with existing Cord
// connection and approval actions. No unverified OPAYA capabilities are implied.
export function createAgentConsoleUI({api,esc,icon,getData,isAdmin,renderOverlays,toast,selectTarget,openModal,loadData,onError}){
  let opened=false,loading=false,working=false,model=null,selected='all',tab='overview',status='all',search='',detail=null;
  let generation=0,refreshTimer=null;
  const allowedStatus=new Set(['queued','running','completed','failed','cancelled','all']);
  const isOpen=()=>opened;
  const agent=id=>model?.agents?.find(a=>a.id===id);
  const agentName=id=>agent(id)?.name||'Unknown agent';
  const humanTime=value=>{
    if(!value)return 'Never';const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Unknown';
    const seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));
    return seconds<60?'Just now':seconds<3600?`${Math.floor(seconds/60)}m ago`:seconds<86400?`${Math.floor(seconds/3600)}h ago`:date.toLocaleString();
  };
  const cls=value=>/^(online|offline|paused|pairing|disconnected|demo|idle|queued|running|completed|failed|cancelled)$/.test(value)?value:'offline';
  const badge=(value)=>`<span class="opaya-console-badge ${cls(value)}"><i></i>${esc(value||'unknown')}</span>`;
  const count=(value)=>Number(value||0).toLocaleString();
  const busyButton=(action,label,id='',extras='')=>`<button type="button" class="opaya-console-action" data-action="${action}" ${id?`data-id="${esc(id)}"`:''} ${working?'disabled':''} ${extras}>${label}</button>`;
  const filteredRuns=()=>{
    const q=search.toLowerCase();return (model?.runs||[]).filter(r=>(selected==='all'||r.agentId===selected)&&(status==='all'||r.status===status)&&
      (!q||`${agentName(r.agentId)} ${r.targetType} ${r.status} ${r.error} ${r.progress}`.toLowerCase().includes(q)));
  };
  const stats=()=>selected==='all'?model?.stats:model?.counts?.[selected]||{total:0,queued:0,running:0,completed:0,failed:0,successRate:null,averageSeconds:null};
  const card=(label,value,sub,variant='')=>`<div class="opaya-console-metric ${variant}"><span>${label}</span><strong>${value}</strong><small>${sub||' '}</small></div>`;
  const runRow=(r)=>`<button type="button" class="opaya-console-run" data-action="opaya-console-run" data-id="${esc(r.id)}">
    <span class="opaya-console-run-status ${cls(r.status)}">${icon(r.status==='failed'?'alert-triangle':r.status==='completed'?'check':'clock',17)}</span>
    <span class="opaya-console-run-main"><b>${esc(agentName(r.agentId))}</b><small>${esc(r.progress||r.error||`${r.targetType} execution`)}</small></span>
    ${badge(r.status)}<time title="${esc(r.createdAt)}">${esc(humanTime(r.createdAt))}</time>${icon('chevron',16)}</button>`;
  const visibleRuns=()=>{
    const rows=filteredRuns();return rows.length?rows.map(runRow).join(''):
      `<div class="opaya-console-empty">${icon('terminal',29)}<strong>No runs match these filters</strong><p>Message an agent in a thread, or change the current filter.</p></div>`;
  };
  const renderAgent=(a)=>{
    const active=selected===a.id,stats=model?.counts?.[a.id]||{};
    return `<button type="button" class="opaya-console-agent ${active?'active':''}" data-action="opaya-console-select" data-id="${esc(a.id)}" aria-pressed="${active}">
      <span class="opaya-console-agent-avatar">${esc(a.name.slice(0,2).toUpperCase())}</span>
      <span class="opaya-console-agent-label"><b>${esc(a.name)}</b><small>${esc(a.runtime||a.type)} ${a.connection?.pending?' - '+count(a.connection.pending)+' pending':''}</small></span>
      <span class="opaya-console-status-dot ${cls(a.status)}" title="${esc(a.status)}"></span>
    </button>`;
  };
  function agentSection(){
    const a=agent(selected);if(!a)return '';
    const device=a.connection?.device;
    return `<section class="opaya-console-agent-details" aria-label="Agent details">
      <div class="opaya-console-section-header"><div><h3>${esc(a.name)}</h3><span>${esc(a.description||'Connected agent')}</span></div>${badge(a.status)}</div>
      <div class="opaya-console-detail-grid"><div><small>Runtime</small><b>${esc(a.runtime||a.type)}</b></div><div><small>Model</small><b>${esc(a.model||'Runtime default')}</b></div>
      <div><small>Reasoning effort</small><b>${esc(a.effort||'Default')}</b></div><div><small>Timeout</small><b>${a.timeoutSeconds?count(a.timeoutSeconds)+'s':'Runtime default'}</b></div>
      <div><small>Device</small><b>${esc(device?.name||'Not paired')}</b></div><div><small>Last heartbeat</small><b>${esc(humanTime(device?.lastSeen))}</b></div>
      <div><small>Bridge version</small><b>${esc(device?.version||'Unknown')}</b></div><div><small>Queue</small><b>${count(a.connection?.pending)}</b></div></div>
      ${a.runtime==='opaya'?`<div class="opaya-console-note">${icon('shield-check',17)} OPAYA runs through the paired desktop service. Native Vault, tools and approval policies stay on the agent's machine.</div>`:''}
      ${a.type==='demo'?`<div class="opaya-console-note">Demo agents simulate responses. No LLM or OPAYA runtime is connected.</div>`:''}
      ${a.type==='bridge'?`<div class="opaya-console-actions">
        ${busyButton('opaya-console-message',`${icon('message-square',16)} Open DM`,a.id)}
        ${busyButton('opaya-console-configure',`${icon('settings',16)} Configure`,a.id)}
        ${busyButton('opaya-console-pause',`${icon(a.paused?'play':'pause',16)} ${a.paused?'Resume':'Pause'}`,a.id)}
        ${busyButton('opaya-console-test',`${icon('check',16)} Test`,a.id)}
        ${busyButton('opaya-console-reconnect',`${icon('refresh-cw',16)} Reconnect`,a.id)}
      </div>`:`<div class="opaya-console-actions">${busyButton('opaya-console-message',`${icon('message-square',16)} Open DM`,a.id)}${busyButton('opaya-console-configure',`${icon('settings',16)} Configure`,a.id)}</div>`}
      <p class="opaya-console-caveat">Capabilities, tool inventories and usage costs are not remotely reported by the current Cord bridge. Status and run information here are real server observations.</p>
    </section>`;
  }
  const approvalRows=()=>{
    const rows=(model?.pendingApprovals||[]).filter(p=>selected==='all'||p.agentId===selected);
    return rows.length?rows.map(p=>`<article class="opaya-console-approval">
      <div class="opaya-console-approval-head">${icon('shield-check',18)}<span><b>${esc(agentName(p.agentId))} needs approval</b><small>${esc(humanTime(p.createdAt))}</small></span></div>
      <p><strong>${esc(p.title)}</strong></p><pre>${esc(p.detail||'The agent requested approval for a tool action.')}</pre>
      <div class="opaya-console-actions">${busyButton('opaya-console-approval',`${icon('check',16)} Approve once`,p.id,'data-decision="approved"')}${busyButton('opaya-console-approval','Decline',p.id,'data-decision="declined"')}</div>
    </article>`).join(''):`<div class="opaya-console-empty">${icon('shield-check',30)}<strong>No approvals waiting</strong><p>When a paired agent needs permission, its request will appear here.</p></div>`;
  };
  const runDetail=()=>{
    if(!detail)return '';
    const r=detail.run;
    return `<div class="opaya-console-detail-screen"><div class="opaya-console-section-header"><button class="opaya-console-link" data-action="opaya-console-back">${icon('arrow',16)} Back to runs</button>${badge(r.status)}</div>
      <h2>${esc(agentName(r.agentId))} execution</h2><div class="opaya-console-detail-grid">
      <div><small>Created</small><b>${esc(humanTime(r.createdAt))}</b></div><div><small>Finished</small><b>${esc(humanTime(r.finishedAt))}</b></div>
      <div><small>Conversation</small><b>${esc(r.targetType)}</b></div><div><small>Run ID</small><b title="${esc(r.id)}">${esc(r.id.slice(0,12))}</b></div></div>
      ${r.progress?`<section class="opaya-console-log"><h3>Last progress update</h3><pre>${esc(r.progress)}</pre></section>`:''}
      ${r.error?`<section class="opaya-console-log error"><h3>Failure</h3><pre>${esc(r.error)}</pre></section>`:''}
      ${(detail.approvals||[]).length?`<section class="opaya-console-log"><h3>Approval history</h3>${detail.approvals.map(p=>`<div class="opaya-console-approval-history"><b>${esc(p.title)}</b>${badge(p.status)}<p>${esc(p.detail)}</p></div>`).join('')}</section>`:''}
      <div class="opaya-console-actions">${busyButton('opaya-console-target',`${icon('message-square',16)} Open conversation`,r.targetId,`data-type="${esc(r.targetType)}"`)}
      ${r.canCancel?busyButton('opaya-console-cancel',`${icon('close',16)} Cancel run`,r.id):''}</div>
      <p class="opaya-console-caveat">Run payloads, tool credentials and private conversation history are not shown in this panel.</p></div>`;
  };
  const tabs=()=>`<div class="opaya-console-tabs" role="tablist" aria-label="Agent Control Center sections">
    ${[['overview','Overview'],['runs','Run history'],['approvals',`Approvals (${(model?.pendingApprovals||[]).length})`]].map(([id,name])=>`<button role="tab" type="button" aria-selected="${tab===id}" class="${tab===id?'active':''}" data-action="opaya-console-tab" data-tab="${id}">${name}</button>`).join('')}
  </div>`;
  const content=()=>{
    if(loading&&!model)return '<div class="opaya-console-loading">Loading agent health and run history...</div>';
    if(!model)return '<div class="opaya-console-empty">Unable to load the Control Center.</div>';
    if(detail)return runDetail();
    const s=stats();const cards=`<div class="opaya-console-metrics">${card('Executions',count(s.total),'Recent accessible runs')}${card('Running',count(s.running),'Active executions','live')}${card('Queued',count(s.queued),'Waiting for bridge')}${card('Success rate',s.successRate==null?'--':s.successRate+'%','Of finished runs')}${card('Failed',count(s.failed),'Needs attention',s.failed?'danger':'')}</div>`;
    const filters=`<div class="opaya-console-toolbar"><label class="opaya-console-search">${icon('search',17)}<input id="opaya-console-search" aria-label="Filter run history" autocomplete="off" placeholder="Search runs and diagnostics" value="${esc(search)}"></label>
      <div class="opaya-console-filter">${[['all','All'],['running','Running'],['queued','Queued'],['failed','Failed'],['completed','Done']].map(([id,label])=>`<button type="button" class="${status===id?'active':''}" data-action="opaya-console-filter" data-status="${id}">${label}</button>`).join('')}</div></div>`;
    return `${tabs()}${tab==='overview'?`${cards}${agentSection()}<div class="opaya-console-section-header"><h3>Recent activity</h3><button class="opaya-console-link" data-action="opaya-console-tab" data-tab="runs">See all runs ${icon('chevron',15)}</button></div><div class="opaya-console-run-list" id="opaya-console-run-list">${visibleRuns().slice(0,38000)}</div>`:
      tab==='approvals'?`<div class="opaya-console-section-header"><h3>Tool approvals</h3></div>${approvalRows()}`:
      `${cards}${filters}<div class="opaya-console-run-list" id="opaya-console-run-list">${visibleRuns()}</div>`}`;
  };
  function overlay(){if(!opened)return '';
    const total=model?.agents?.length||0;const online=(model?.agents||[]).filter(a=>a.status==='online').length;
    return `<div class="opaya-console-backdrop" data-action="opaya-console-close"><section class="opaya-console" data-stop-click="true" role="dialog" aria-modal="true" aria-label="OPAYA Agent Control Center">
      <header class="opaya-console-head"><div class="opaya-console-head-icon">${icon('bot',25)}</div><div><small>CORD AI / OPAYA</small><h1>Agent Control Center</h1><p>Manage connected agents, observe runs and approve tools.</p></div>
      <div class="opaya-console-head-actions"><span class="opaya-console-live"><i></i> Connected to Cord</span>${busyButton('opaya-console-refresh',`${icon('refresh-cw',17)} Refresh`)}<button type="button" class="opaya-console-close" data-action="opaya-console-close" title="Close" aria-label="Close">${icon('close',20)}</button></div></header>
      <div class="opaya-console-workspace"><div class="opaya-console-nav"><div class="opaya-console-nav-head"><strong>CONNECTED AGENTS</strong><span>${online}/${total} online</span></div>
        <button type="button" data-action="opaya-console-select" data-id="all" class="opaya-console-all ${selected==='all'?'active':''}">${icon('users',19)} All agents <span>${total}</span></button>
        <div class="opaya-console-agent-list">${(model?.agents||[]).map(renderAgent).join('')||'<p class="opaya-console-sidebar-empty">No agents yet.</p>'}</div>
        <div class="opaya-console-nav-bottom">${busyButton('opaya-console-connect',`${icon('plus',17)} Connect agent`)}<small>${esc(model?.generatedAt?'Updated '+humanTime(model.generatedAt):'')}</small></div>
      </div><main class="opaya-console-center">${content()}</main></div>
      <footer class="opaya-console-foot">${icon('shield-check',15)} Admin access only. Device tokens, secrets and prompts stay private. ${model?`Showing at most ${model.sampleSize} recent accessible runs.`:''}</footer>
    </section></div>`;
  }
  async function refresh({quiet=false}={}){
    if(!opened||!getData().workspace?.id)return;
    const current=++generation;
    if(!quiet){loading=true;renderOverlays()}
    try{
      const result=await api('/agent-console?workspaceId='+encodeURIComponent(getData().workspace.id));
      if(current!==generation||!opened)return;
      model=result;loading=false;
      if(selected!=='all'&&!agent(selected))selected='all';
      renderOverlays();
    }catch(err){if(current!==generation||!opened)return;loading=false;if(!quiet)onError(err);renderOverlays()}
  }
  async function open(agentId='all'){
    if(!isAdmin()){toast('Only workspace admins can manage agent runtimes.','error');return}
    selected=agentId||'all';opened=true;detail=null;tab='overview';status='all';search='';model=null;
    renderOverlays();await refresh();
  }
  function close(){if(!opened)return false;opened=false;generation++;detail=null;if(refreshTimer)clearTimeout(refreshTimer);renderOverlays();return true}
  function event(){if(!opened||refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh({quiet:true})},380)}
  async function withAction(task){if(working)return;working=true;renderOverlays();try{await task()}catch(err){onError(err)}finally{working=false;if(opened)renderOverlays()}}
  async function handleAction(action,button){
    if(!action?.startsWith('opaya-console-'))return false;
    const id=button?.dataset?.id||'';
    if(action==='opaya-console-open'){await open(id||'all');return true}
    if(action==='opaya-console-close'){close();return true}
    if(!opened)return true;
    if(action==='opaya-console-refresh'){await refresh();return true}
    if(action==='opaya-console-select'){selected=id;detail=null;renderOverlays();return true}
    if(action==='opaya-console-tab'){tab=button.dataset.tab||'overview';status='all';search='';detail=null;renderOverlays();return true}
    if(action==='opaya-console-filter'){const next=button.dataset.status||'all';if(allowedStatus.has(next)){status=next;renderOverlays()}return true}
    if(action==='opaya-console-run'){await withAction(async()=>{const result=await api('/agent-console/runs/'+encodeURIComponent(id));detail=result;renderOverlays()});return true}
    if(action==='opaya-console-back'){detail=null;renderOverlays();return true}
    if(action==='opaya-console-connect'){close();openModal('easy-connect');return true}
    if(action==='opaya-console-configure'){const a=agent(id);if(a){close();openModal(a.type==='bridge'?'connection-settings':'edit-agent',{id})}return true}
    if(action==='opaya-console-target'){const type=button.dataset.type;if(['channel','thread','dm'].includes(type)){close();selectTarget(type,id)}return true}
    if(action==='opaya-console-message'){
      await withAction(async()=>{const result=await api('/dms',{method:'POST',body:{workspaceId:getData().workspace.id,agentId:id}});close();await loadData({messages:false});selectTarget('dm',result.id)});return true;
    }
    if(action==='opaya-console-pause'){
      const a=agent(id);if(a?.type==='bridge')await withAction(async()=>{await api(`/agent-connections/${encodeURIComponent(id)}/pause`,{method:'POST',body:{paused:!a.paused}});toast(a.paused?'Agent resumed':'Agent paused');await refresh({quiet:true})});return true;
    }
    if(action==='opaya-console-test'){
      await withAction(async()=>{const result=await api(`/agent-connections/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});close();await loadData({messages:false});selectTarget('dm',result.dmId)});return true;
    }
    if(action==='opaya-console-reconnect'){
      const a=agent(id);if(a?.type==='bridge')await withAction(async()=>{const result=await api('/agent-connections',{method:'POST',body:{workspaceId:getData().workspace.id,agentId:id,runtime:a.runtime}});close();openModal('easy-connect',result)});return true;
    }
    if(action==='opaya-console-cancel'){
      await withAction(async()=>{await api(`/runs/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}});detail=null;toast('Run cancellation requested');await refresh({quiet:true})});return true;
    }
    if(action==='opaya-console-approval'){
      const decision=button.dataset.decision;
      if(['approved','declined'].includes(decision))await withAction(async()=>{await api(`/approvals/${encodeURIComponent(id)}`,{method:'POST',body:{decision}});toast(decision==='approved'?'Tool action approved once':'Tool action declined');await refresh({quiet:true})});return true;
    }
    return true;
  }
  function input(event){if(!opened||event.target?.id!=='opaya-console-search')return false;
    search=event.target.value;const list=document.querySelector('#opaya-console-run-list');if(list)list.innerHTML=visibleRuns();return true;
  }
  const settingsCard=()=>`<div class="settings-section"><h2>Agent Control Center</h2><p class="muted-paragraph">Inspect OPAYA and other connected agents, check device heartbeat and queues, review runs and manage tool approvals. Only admins can access private operational telemetry.</p><button type="button" class="button-primary" data-action="opaya-console-open">${icon('bot',17)} Open Agent Control Center</button></div>`;
  return {open,close,isOpen,overlay,handleAction,event,input,settingsCard,refresh};
}
