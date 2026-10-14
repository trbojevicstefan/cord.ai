// Cord Operator is deliberately an admin-only control plane. All mutations are approved on the server.
export function createOperatorPanel({api,icon,esc,getData,isAdmin,onWorkspaceChanged,onError}){
  let root=null,mode='chat',loading=false,config=null,feed=[],approval=null,error='',draft='',activity=[];
  const ws=()=>getData()?.workspace?.id;
  const workspaceBody=extra=>({workspaceId:ws(),...extra});
  const providerOptions=()=>config?.providers||[];
  const button=(action,label,cls='')=>`<button type="button" class="operator-btn ${cls}" data-op-action="${action}">${label}</button>`;
  const escLines=x=>esc(String(x??''));
  const time=()=>new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  function render(){
    if(!root)return;
    const configured=config?.enabled;
    const provider=providerOptions().find(p=>p.id===config?.provider);
    root.innerHTML=`<div class="operator-shade" data-op-action="close"></div><section class="operator-window" role="dialog" aria-modal="true" aria-label="Cord AI Operator">
      <header class="operator-top"><div class="operator-mark">${icon('sparkles',22)}</div><div><strong>Cord Operator</strong><span>Workspace copilot · Admin control</span></div><div class="operator-top-right"><span class="operator-status ${configured?'active':''}">${configured?'● Connected':'○ Not configured'}</span>${button('close',icon('close',19),'operator-icon')}</div></header>
      <nav class="operator-tabs" aria-label="Operator tabs"><button type="button" data-op-action="tab-chat" class="${mode==='chat'?'active':''}">✧ Ask Cord</button><button type="button" data-op-action="tab-settings" class="${mode==='settings'?'active':''}">⚙ Model connection</button><button type="button" data-op-action="tab-activity" class="${mode==='activity'?'active':''}">◷ Activity</button></nav>
      ${mode==='chat'?`<div class="operator-scroll" id="operator-scroll"><div class="operator-intro"><span class="operator-intro-icon">✦</span><h3>What should Cord handle?</h3><p>Ask about your workspace or propose changes in plain language. Cord can organize channels, start threads, assign agents and post updates—with your approval.</p></div>
        ${feed.map(m=>`<div class="operator-message ${m.role}"><span class="operator-message-label">${m.role==='user'?'You':'Cord Operator'} <small>${esc(m.time||'')}</small></span><div>${escLines(m.content)}</div></div>`).join('')}
        ${!configured?`<div class="operator-notice">${icon('info',17)} Connect a model to enable Operator. No workspace content is sent to an external model until you configure it and ask a question. ${button('tab-settings','Configure model','inline')}</div>`:''}
        ${error?`<div class="operator-notice danger">${esc(error)}</div>`:''}
        ${approval?`<div class="operator-approval"><div class="operator-approval-heading">${icon('shield-check',18)} Human approval required</div><p>The model proposed an action, but Cord has <strong>not executed it</strong>. Review the exact parameters.</p><strong>${esc(approval.summary)}</strong><pre>${esc(JSON.stringify(approval.args,null,2))}</pre><div class="operator-actions">${button('reject','Reject','secondary')}${button('approve','Approve & execute','primary')}</div><small>Expires ${esc(new Date(approval.expiresAt).toLocaleTimeString())}; only your account can approve.</small></div>`:''}
        ${loading?`<div class="operator-thinking"><span></span><span></span><span></span> Consulting ${esc(provider?.label||'model')}…</div>`:''}
        ${!feed.length&&!approval&&!loading?`<div class="operator-suggestions"><button data-op-prompt="Summarize my workspace and tell me which threads need attention.">Summarize my workspace</button><button data-op-prompt="Suggest a channel structure for a product launch.">Plan a product launch</button><button data-op-prompt="Which agents are connected and available?">Check connected agents</button><button data-op-prompt="Create a thread called Weekly AI Planning in the most relevant channel.">Create a planning thread</button></div>`:''}
        </div><form id="operator-prompt-form" class="operator-composer"><label for="operator-question" class="sr-only">Ask Cord Operator</label><textarea id="operator-question" maxlength="3000" placeholder="e.g. Create an engineering channel and assign the design agent…" ${!configured||loading?'disabled':''}>${esc(draft)}</textarea><div class="operator-composer-foot"><span>${icon('shield-check',14)} Writes need approval · Enter to send · Shift+Enter for newline</span><button class="operator-send" type="submit" ${!configured||loading?'disabled':''} title="Send">${icon('arrow',17)}</button></div></form>`:
      mode==='settings'?`<form id="operator-config-form" class="operator-config"><h3>Bring your own model</h3><p>Cord Operator runs server-side using your selected LLM. Connect OpenAI, Anthropic, OpenRouter, Groq, Gemini, or any allowlisted OpenAI-compatible endpoint (including local Ollama in dev mode).</p><label>LLM PROVIDER<select name="provider" id="operator-provider">${providerOptions().map(p=>`<option value="${esc(p.id)}" ${p.id===config?.provider?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><label>MODEL NAME<input type="text" name="model" required maxlength="140" value="${esc(config?.model||'')}" placeholder="Choose a model"></label><label class="operator-compatible ${config?.provider==='compatible'?'':'hidden'}" id="operator-endpoint-row">CHAT COMPLETIONS ENDPOINT<input type="url" name="endpoint" value="${esc(config?.endpoint||'')}" placeholder="https://llm.example.com/v1/chat/completions"><small>Custom remote hosts must be in CORD_LLM_ALLOWED_HOSTS. Only demo/dev mode permits loopback HTTP.</small></label><label>API KEY ${config?.hasKey?'<span class="operator-key-present">● Encrypted key stored</span>':''}<input type="password" name="apiKey" autocomplete="new-password" placeholder="${config?.hasKey?'Leave blank to keep saved key':'Paste your model provider API key'}"></label><label class="operator-checkbox"><input type="checkbox" name="enabled" ${config?.enabled?'checked':''}> Enable Cord Operator for workspace admins</label><div class="operator-notice subtle">${icon('shield-check',17)} Keys are encrypted with CORD_MASTER_KEY and never sent to the browser. Model requests may include public channel and thread messages needed to answer. DMs and secrets are excluded.</div>${error?`<div class="operator-notice danger">${esc(error)}</div>`:''}<div class="operator-actions">${button('close','Cancel','secondary')}<button class="operator-btn primary" type="submit" ${loading?'disabled':''}>${loading?'Saving…':'Save model connection'}</button></div></form>`:
      `<div class="operator-activity"><h3>Operator activity</h3><p>Recent requests and approval decisions are associated with your user and workspace.</p>${activity.length?activity.map(a=>`<div class="operator-activity-row"><span>${a.kind==='execute'?'✓':a.kind==='proposal'?'◷':a.kind==='reject'?'×':'●'}</span><div><strong>${esc(a.summary)}</strong><small>${esc(new Date(a.created_at).toLocaleString())} · ${esc(a.kind)}</small></div></div>`).join(''):'<div class="operator-empty">No activity yet.</div>'}<div class="operator-actions">${button('refresh-activity','Refresh activity','secondary')}</div></div>`}
      <footer class="operator-foot">CORD AI · Workspace-scoped tools · No shell access · Human-approved changes</footer></section>`;
    const scroll=root.querySelector('#operator-scroll');if(scroll)scroll.scrollTop=scroll.scrollHeight;
    const q=root.querySelector('#operator-question');if(q&&mode==='chat'&&!loading)q.focus({preventScroll:true});
  }
  async function loadConfig(){const r=await api('/operator/config?workspaceId='+encodeURIComponent(ws()));config=r.config;}
  async function loadActivity(){const r=await api('/operator/activity?workspaceId='+encodeURIComponent(ws()));activity=r.history||[];}
  async function open(next='chat'){
    if(!isAdmin()){onError(new Error('Only workspace admins can configure or use Cord Operator'));return}
    if(!ws())return;
    mode=next;error='';root=document.getElementById('cord-operator-root');if(!root){root=document.createElement('div');root.id='cord-operator-root';document.body.append(root);}
    root.classList.add('operator-open');root.addEventListener('click',handleClick);root.addEventListener('submit',handleSubmit);root.addEventListener('input',handleInput);root.addEventListener('change',handleChange);root.addEventListener('keydown',handleKeydown);
    try{await loadConfig();if(mode==='activity')await loadActivity();}catch(e){error=e.message}
    render();
  }
  function close(){if(!root)return;root.removeEventListener('click',handleClick);root.removeEventListener('submit',handleSubmit);root.removeEventListener('input',handleInput);root.removeEventListener('change',handleChange);root.removeEventListener('keydown',handleKeydown);root.remove();root=null;}
  function handleInput(event){if(event.target.id==='operator-question')draft=event.target.value;}
  function handleChange(event){if(event.target.id==='operator-provider'){
      const p=providerOptions().find(p=>p.id===event.target.value);const model=root.querySelector('input[name=model]');if(model&&p)model.value=p.model;
      root.querySelector('#operator-endpoint-row')?.classList.toggle('hidden',event.target.value!=='compatible');
    }}
  function handleKeydown(event){if(event.key==='Escape'){event.stopPropagation();close();return}if(event.key==='Enter'&&event.target.id==='operator-question'&&!event.shiftKey&&!event.isComposing){event.preventDefault();root.querySelector('#operator-prompt-form')?.requestSubmit()}}
  async function handleClick(event){const suggestion=event.target.closest('[data-op-prompt]');if(suggestion){draft=suggestion.dataset.opPrompt;render();return}
    const button=event.target.closest('[data-op-action]');if(!button)return;
    event.preventDefault();const action=button.dataset.opAction;
    if(action==='close')return close();
    if(action==='tab-chat'||action==='tab-settings'||action==='tab-activity'){
      mode=action.replace('tab-','');error='';if(mode==='activity'){try{await loadActivity()}catch(e){error=e.message}}render();return;
    }
    if(action==='refresh-activity'){try{await loadActivity()}catch(e){error=e.message}render();return}
    if(action==='approve'||action==='reject'){
      if(!approval||loading)return;const proposal=approval;loading=true;error='';render();
      try{
        if(action==='approve'){
          const r=await api('/operator/approve',{method:'POST',body:workspaceBody({approvalId:proposal.id})});
          feed.push({role:'assistant',content:`Approved and executed: ${proposal.summary}. ${JSON.stringify(r.result)}`,time:time()});approval=null;await onWorkspaceChanged();
        }else{await api('/operator/reject',{method:'POST',body:workspaceBody({approvalId:proposal.id})});feed.push({role:'assistant',content:'Proposal rejected. No changes were made.',time:time()});approval=null;}
      }catch(e){error=e.message}finally{loading=false;render()}return;
    }
  }
  async function handleSubmit(event){
    if(event.target.id==='operator-prompt-form'){
      event.preventDefault();if(loading||!config?.enabled||!draft.trim())return;
      const prompt=draft.trim();draft='';feed.push({role:'user',content:prompt,time:time()});loading=true;error='';render();
      try{const result=await api('/operator/ask',{method:'POST',body:workspaceBody({prompt})});feed.push({role:'assistant',content:result.answer||'Request completed.',time:time()});approval=result.approval||null;}
      catch(e){error=e.message;}finally{loading=false;render()}return;
    }
    if(event.target.id==='operator-config-form'){
      event.preventDefault();if(loading)return;const form=event.target,fd=new FormData(form);loading=true;error='';
      const provider=String(fd.get('provider')||'openai');const body=workspaceBody({provider,model:String(fd.get('model')||''),endpoint:provider==='compatible'?String(fd.get('endpoint')||''):'',apiKey:String(fd.get('apiKey')||''),enabled:fd.get('enabled')==='on'});
      try{const result=await api('/operator/config',{method:'PATCH',body});config=result.config;feed.push({role:'assistant',content:`Model connection saved: ${config.provider} / ${config.model}. ${config.enabled?'Operator is ready.':'Operator is disabled until you enable it.'}`,time:time()});mode='chat';}
      catch(e){error=e.message;}finally{loading=false;render()}return;
    }
  }
  return {open,close,isOpen:()=>!!root};
}
