// Cord workspace roles and inherited Discord-like channel/category permissions.
export function createAccessUI({api,esc,icon,getData,isAdmin,toast,render,renderOverlays}) {
  let model=null, selectedRole=null, scope=null, loading=false;
  const workspace=()=>getData().workspace?.id;
  const roles=()=>model?.roles||[];
  const nameOfScope=(type,id)=>type==='category'?(getData().categories||[]).find(x=>x.id===id)?.name:(getData().channels||[]).find(x=>x.id===id)?.name;
  const option=(value,label,active)=>`<option value="${esc(value)}" ${active===value?'selected':''}>${esc(label)}</option>`;
  const selector=(field,value)=>`<select class="access-select" data-permission="${field}" aria-label="${field==='can_view'?'Read':'Send'} permission">${option(-1,'Inherit',value)}${option(1,'Allow',value)}${option(0,'Deny',value)}</select>`;
  const fetchAll=async()=>{if(!workspace()||!isAdmin())return;const result=await api('/access?workspaceId='+encodeURIComponent(workspace()));model=result;if(!selectedRole||!roles().some(x=>x.id===selectedRole))selectedRole=roles()[0]?.id||null};
  async function load(){if(loading)return;loading=true;try{await fetchAll();render();}catch(e){toast(e.message,'error')}finally{loading=false}}
  function rolePage(){
    if(!isAdmin())return '<div class="settings-page-title">Roles & Permissions</div><p>Only workspace administrators can manage roles.</p>';
    const role=roles().find(x=>x.id===selectedRole);
    return `<div class="settings-page-title">Roles & Permissions</div><div class="access-intro"><div><strong>Secure your workspace</strong><p>Give people a role, then set who can read and post in each category or channel. Owners and admins always retain access.</p></div>${icon('shield-check',30)}</div>
     <div class="access-layout"><aside class="access-roles"><div class="access-subheading">WORKSPACE ROLES</div>
      ${roles().map(x=>`<button type="button" class="access-role ${selectedRole===x.id?'chosen':''}" data-action="access-select-role" data-id="${esc(x.id)}"><i style="background:${esc(x.color)}"></i><span>${esc(x.name)}</span></button>`).join('')||'<p class="access-muted">No roles yet. Create one below.</p>'}
      <form data-form="access-create-role" class="access-new-role"><input class="form-control" type="text" name="name" minlength="2" maxlength="40" required placeholder="New role name" aria-label="Role name"><button type="submit" class="button-primary">Create</button></form>
     </aside><section class="access-role-editor">${role?`<div class="access-editor-head"><span class="access-pill" style="--role-color:${esc(role.color)}">${esc(role.name)}</span><button type="button" class="button-danger" data-action="access-delete-role" data-id="${esc(role.id)}">Delete role</button></div><p class="access-muted">Select who belongs to this role. Member access changes immediately.</p>
      ${model.members.map(u=>`<label class="access-member"><span><b>${esc(u.display_name)}</b><small>@${esc(u.username)} ${u.role==='owner'||u.role==='admin'?'· Administrator':''}</small></span><input data-action="access-toggle-member" data-role="${esc(role.id)}" data-user="${esc(u.id)}" type="checkbox" ${model.roleMembers.some(m=>m.role_id===role.id&&m.user_id===u.id)?'checked':''}/></label>`).join('')}
      <p class="access-muted">To configure visibility, right-click a channel or category and choose <strong>Permissions</strong>.</p>`:'<div class="access-empty">Select or create a role to manage memberships.</div>'}</section></div>`;
  }
  function ruleRow(subjectType,subjectId,name){
    const found=model?.overrides.find(x=>x.scope_type===scope.type&&x.scope_id===scope.id&&x.subject_type===subjectType&&x.subject_id===subjectId);
    return `<div class="access-rule" data-subject-type="${esc(subjectType)}" data-subject-id="${esc(subjectId)}"><div class="access-rule-title">${esc(name)}<small>${subjectType==='everyone'?'Default for all members':subjectType==='role'?'Role override':'Individual override'}</small></div>
      <label>VIEW${selector('can_view',found?.can_view??-1)}</label><label>POST${selector('can_post',found?.can_post??-1)}</label>
      <button class="access-rule-save" type="button" data-action="access-save-rule" title="Save this rule">${icon('check',16)} Save</button>${found?`<button class="access-rule-remove" type="button" data-action="access-remove-rule" title="Restore inherited permissions">${icon('trash',15)}</button>`:''}</div>`;
  }
  function overlay(){if(!scope)return '';
    const name=nameOfScope(scope.type,scope.id)||'conversation';
    const members=model?.members||[];
    const rows=model?`${ruleRow('everyone','everyone','@everyone')}${roles().map(r=>ruleRow('role',r.id,r.name)).join('')}${model.overrides.filter(x=>x.scope_type===scope.type&&x.scope_id===scope.id&&x.subject_type==='user').map(x=>{const u=members.find(u=>u.id===x.subject_id);return u?ruleRow('user',u.id,u.display_name):''}).join('')}`:'<p>Loading permissions...</p>';
    return `<div class="access-backdrop" data-action="access-close"><section class="access-dialog" role="dialog" aria-modal="true" aria-label="Permissions for ${esc(name)}" data-stop-click="true"><header><div><small>ACCESS CONTROL · ${esc(scope.type.toUpperCase())}</small><h2>${scope.type==='channel'?'# ':''}${esc(name)} permissions</h2></div><button class="icon-btn" data-action="access-close" aria-label="Close permission editor">${icon('close',21)}</button></header>
      <p class="access-help">Permissions inherit from the parent category. Individual member overrides take precedence over roles. Conflicting role grants resolve to Deny. Admins cannot lock themselves out.</p><div class="access-table-head"><span>WHO</span><span>READ</span><span>SEND</span></div><div class="access-rules">${rows}</div>
      <div class="access-dialog-footer"><select id="access-pick-member" class="access-select" aria-label="Add member override"><option value="">Individual member override...</option>${members.filter(u=>!model?.overrides.some(x=>x.scope_type===scope.type&&x.scope_id===scope.id&&x.subject_type==='user'&&x.subject_id===u.id)).map(u=>option(u.id,u.display_name,'')).join('')}</select><button class="button-secondary" data-action="access-add-member" type="button">Add member</button></div></section></div>`;
  }
  async function open(type,id){scope={type,id};model=null;renderOverlays();try{await fetchAll();renderOverlays()}catch(e){scope=null;toast(e.message,'error');renderOverlays()}}
  async function handle(action,button){
    if(!action?.startsWith('access-'))return false;
    const done=async fn=>{try{await fn();await fetchAll();render();renderOverlays()}catch(e){toast(e.message,'error')}};
    switch(action){
      case 'access-open':await open(button.dataset.type,button.dataset.id);break;
      case 'access-close':scope=null;renderOverlays();break;
      case 'access-select-role':selectedRole=button.dataset.id;render();break;
      case 'access-delete-role':if(confirm('Delete this role and all of its permission rules?'))await done(()=>api('/access/roles/'+encodeURIComponent(button.dataset.id),{method:'DELETE'}));break;
      case 'access-toggle-member':await done(()=>api('/access/roles/'+encodeURIComponent(button.dataset.role)+'/members',{method:'POST',body:{userId:button.dataset.user,enabled:button.checked}}));break;
      case 'access-save-rule':{
        const row=button.closest('.access-rule');if(!row||!scope)break;
        const canView=Number(row.querySelector('[data-permission="can_view"]')?.value),canPost=Number(row.querySelector('[data-permission="can_post"]')?.value);
        await done(()=>api('/access/overrides',{method:'POST',body:{workspaceId:workspace(),scopeType:scope.type,scopeId:scope.id,subjectType:row.dataset.subjectType,subjectId:row.dataset.subjectId,canView,canPost}}));toast('Permission saved');break;
      }
      case 'access-remove-rule':{
        const row=button.closest('.access-rule');if(row&&scope)await done(()=>api('/access/overrides',{method:'DELETE',body:{workspaceId:workspace(),scopeType:scope.type,scopeId:scope.id,subjectType:row.dataset.subjectType,subjectId:row.dataset.subjectId}}));break;
      }
      case 'access-add-member':{
        const id=document.querySelector('#access-pick-member')?.value;if(!id||!scope)break;
        await done(()=>api('/access/overrides',{method:'POST',body:{workspaceId:workspace(),scopeType:scope.type,scopeId:scope.id,subjectType:'user',subjectId:id,canView:-1,canPost:-1}}));break;
      }
      default:return false;
    }return true;
  }
  async function submit(form){if(form.dataset.form!=='access-create-role')return false;
    try{const r=await api('/access/roles',{method:'POST',body:{workspaceId:workspace(),name:form.querySelector('[name="name"]').value}});selectedRole=r.id;await fetchAll();render()}catch(e){toast(e.message,'error')}return true;
  }
  return {load,page:rolePage,overlay,handle,submit};
}
