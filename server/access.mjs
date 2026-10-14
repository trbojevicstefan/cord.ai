import { randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), {status});
const short = (value, n = 80) => String(value ?? '').trim().slice(0, n);
const ruleValue = value => Number.isInteger(Number(value)) && [-1, 0, 1].includes(Number(value)) ? Number(value) : null;

// Workspace roles and inheritable category/channel ACLs. The server remains authoritative.
export function createAccess({store, requireWorkspace, requireAdmin, audit, broadcast, bodyJSON, asJSON}) {
  const {db, get, all, run} = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS cord_roles (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8b95a9', position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cord_roles_name ON cord_roles(workspace_id,name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS cord_role_members (
      role_id TEXT NOT NULL REFERENCES cord_roles(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(role_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS cord_overrides (
      scope_type TEXT NOT NULL CHECK(scope_type IN ('category','channel')),
      scope_id TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('everyone','role','user')),
      subject_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT -1 CHECK(can_view IN (-1,0,1)),
      can_post INTEGER NOT NULL DEFAULT -1 CHECK(can_post IN (-1,0,1)),
      PRIMARY KEY(scope_type,scope_id,subject_type,subject_id)
    );
    CREATE INDEX IF NOT EXISTS cord_overrides_scope ON cord_overrides(scope_type,scope_id);
  `);
  const roleIds = (userId, ws) => new Set(all(`SELECT r.id FROM cord_roles r JOIN cord_role_members m ON m.role_id=r.id WHERE m.user_id=? AND r.workspace_id=?`,userId,ws).map(x=>x.id));
  const membership = (userId, ws) => get('SELECT role FROM memberships WHERE user_id=? AND workspace_id=?',userId,ws);
  const isAdmin = (userId, ws) => ['owner','admin'].includes(membership(userId,ws)?.role);
  const channelFor = id => get('SELECT id,workspace_id,category_id FROM channels WHERE id=?',id);

  // A more-specific scope overrides its parent. At a scope: user > any role > everyone.
  // Conflicting role grants resolve deny-first, preventing accidental privilege broadening.
  function resolveScope(userId, ws, scopeType, scopeId, field, inherited, roles) {
    if(!scopeId) return inherited;
    const rows = all('SELECT * FROM cord_overrides WHERE scope_type=? AND scope_id=?',scopeType,scopeId);
    let value = inherited;
    const everyone = rows.find(x=>x.subject_type==='everyone');
    if(everyone && everyone[field]!==-1) value=everyone[field]===1;
    const grants=rows.filter(x=>x.subject_type==='role'&&roles.has(x.subject_id)&&x[field]!==-1);
    if(grants.some(x=>x[field]===0)) value=false;
    else if(grants.some(x=>x[field]===1)) value=true;
    const specific=rows.find(x=>x.subject_type==='user'&&x.subject_id===userId);
    if(specific && specific[field]!==-1) value=specific[field]===1;
    return value;
  }
  function allowed(userId, channelId, permission='view') {
    const ch=channelFor(channelId);
    if(!ch || !membership(userId,ch.workspace_id))return false;
    if(isAdmin(userId,ch.workspace_id))return true;
    const roles=roleIds(userId,ch.workspace_id);
    let view=true, post=true;
    for(const [type,id] of [['category',ch.category_id],['channel',ch.id]]) {
      view=resolveScope(userId,ch.workspace_id,type,id,'can_view',view,roles);
      post=resolveScope(userId,ch.workspace_id,type,id,'can_post',post,roles);
    }
    return permission==='post' ? view && post : view;
  }
  function scopeInWorkspace(ws,type,id) {
    if(!['category','channel'].includes(type))throw fail(400,'Unsupported permission scope');
    const table=type==='channel'?'channels':'categories';
    if(!get(`SELECT id FROM ${table} WHERE id=? AND workspace_id=?`,id,ws))throw fail(404,'Scope not found');
  }
  function cleanupScope(type,id){run('DELETE FROM cord_overrides WHERE scope_type=? AND scope_id=?',type,id)}
  function cleanupRole(id){run('DELETE FROM cord_overrides WHERE subject_type=? AND subject_id=?','role',id)}
  function sendChange(user,ws,action,targetType,targetId){audit(user.id,ws,action,targetType,targetId);broadcast(ws,'change',{scope:'access'});}

  async function api(req,res,url,user){
    const path=url.pathname;
    if(!path.startsWith('/api/access'))return false;
    if(path==='/api/access'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));requireAdmin(user.id,ws.id);
      const roles=all('SELECT id,name,color,position FROM cord_roles WHERE workspace_id=? ORDER BY position,name',ws.id);
      const roleMembers=all('SELECT r.id AS role_id,m.user_id FROM cord_roles r JOIN cord_role_members m ON m.role_id=r.id WHERE r.workspace_id=?',ws.id);
      const scopes=all('SELECT id FROM channels WHERE workspace_id=?',ws.id).map(x=>x.id);
      const categories=all('SELECT id FROM categories WHERE workspace_id=?',ws.id).map(x=>x.id);
      const overrides=all('SELECT * FROM cord_overrides').filter(x=>x.scope_type==='channel'?scopes.includes(x.scope_id):categories.includes(x.scope_id));
      const members=all('SELECT u.id,u.display_name,u.username,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.display_name',ws.id);
      asJSON(res,200,{ok:true,roles,roleMembers,overrides,members});return true;
    }
    const wsId=()=>requireWorkspace(user.id,url.searchParams.get('workspaceId')||'').id;
    if(path==='/api/access/roles'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);
      if(all('SELECT id FROM cord_roles WHERE workspace_id=?',ws.id).length>=40)throw fail(400,'Maximum 40 roles per workspace');
      const name=short(input.name,40);if(name.length<2)throw fail(400,'Role name must be at least two characters');
      const color=/^#[0-9a-f]{6}$/i.test(input.color)?input.color:'#8b95a9';
      const id=randomUUID();try{run('INSERT INTO cord_roles(id,workspace_id,name,color,position,created_at) VALUES(?,?,?,?,?,?)',id,ws.id,name,color,all('SELECT id FROM cord_roles WHERE workspace_id=?',ws.id).length,new Date().toISOString())}
      catch(error){if(/UNIQUE/i.test(error.message))throw fail(409,'Role name already exists');throw error}
      sendChange(user,ws.id,'role.create','role',id);asJSON(res,201,{ok:true,id});return true;
    }
    const roleRoute=path.match(/^\/api\/access\/roles\/([^/]+)$/);
    if(roleRoute && ['PATCH','DELETE'].includes(req.method)){
      const role=get('SELECT * FROM cord_roles WHERE id=?',roleRoute[1]);if(!role)throw fail(404,'Role not found');
      requireWorkspace(user.id,role.workspace_id);requireAdmin(user.id,role.workspace_id);
      if(req.method==='DELETE'){
        cleanupRole(role.id);run('DELETE FROM cord_roles WHERE id=?',role.id);
        sendChange(user,role.workspace_id,'role.delete','role',role.id);
      }else{
        const input=await bodyJSON(req);const name=short(input.name??role.name,40);
        if(name.length<2)throw fail(400,'Invalid role name');
        const color=input.color===undefined?role.color:(/^#[0-9a-f]{6}$/i.test(input.color)?input.color:null);
        if(!color)throw fail(400,'Invalid color');
        try{run('UPDATE cord_roles SET name=?,color=? WHERE id=?',name,color,role.id)}catch(error){if(/UNIQUE/i.test(error.message))throw fail(409,'Role name already exists');throw error}
        sendChange(user,role.workspace_id,'role.update','role',role.id);
      }
      asJSON(res,200,{ok:true});return true;
    }
    const memberRoute=path.match(/^\/api\/access\/roles\/([^/]+)\/members$/);
    if(memberRoute&&req.method==='POST'){
      const input=await bodyJSON(req),role=get('SELECT * FROM cord_roles WHERE id=?',memberRoute[1]);if(!role)throw fail(404,'Role not found');
      requireWorkspace(user.id,role.workspace_id);requireAdmin(user.id,role.workspace_id);
      if(!get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',role.workspace_id,short(input.userId,100)))throw fail(404,'Member not found');
      if(typeof input.enabled!=='boolean')throw fail(400,'enabled must be a boolean');
      if(input.enabled)run('INSERT OR IGNORE INTO cord_role_members(role_id,user_id) VALUES(?,?)',role.id,input.userId);
      else run('DELETE FROM cord_role_members WHERE role_id=? AND user_id=?',role.id,input.userId);
      sendChange(user,role.workspace_id,'role.membership','role',role.id);asJSON(res,200,{ok:true});return true;
    }
    if(path==='/api/access/overrides' && ['POST','DELETE'].includes(req.method)){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);
      const type=short(input.scopeType,20),id=short(input.scopeId,100),subject=short(input.subjectType,20);
      scopeInWorkspace(ws.id,type,id);
      if(!['everyone','role','user'].includes(subject))throw fail(400,'Invalid permission subject');
      const subjectId=subject==='everyone'?'everyone':short(input.subjectId,100);
      if(subject==='role'&&!get('SELECT 1 FROM cord_roles WHERE id=? AND workspace_id=?',subjectId,ws.id))throw fail(404,'Role not found');
      if(subject==='user'&&!get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',ws.id,subjectId))throw fail(404,'Member not found');
      if(req.method==='DELETE')run('DELETE FROM cord_overrides WHERE scope_type=? AND scope_id=? AND subject_type=? AND subject_id=?',type,id,subject,subjectId);
      else{
        if(![-1,0,1].includes(input.canView)||![-1,0,1].includes(input.canPost))throw fail(400,'Permissions must be Allow, Deny, or Inherit');
        run(`INSERT INTO cord_overrides(scope_type,scope_id,subject_type,subject_id,can_view,can_post) VALUES(?,?,?,?,?,?)
          ON CONFLICT(scope_type,scope_id,subject_type,subject_id) DO UPDATE SET can_view=excluded.can_view,can_post=excluded.can_post`,type,id,subject,subjectId,input.canView,input.canPost);
      }
      sendChange(user,ws.id,'access.override',type,id);asJSON(res,200,{ok:true});return true;
    }
    throw fail(404,'Access endpoint not found');
  }
  return {api,allowed,cleanupScope,cleanupRole};
}
