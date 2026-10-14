import { hashPassword, verifyPassword, now } from './database.mjs';
const defaults={theme:'dark',density:'comfortable',fontSize:13,enterToSend:true,showTyping:true,desktopNotifications:false,notificationSound:false,onboardingComplete:false,
  notifyDirectMessages:true,notifyMentions:true,notifyReplies:true,
  notifyThreadActivity:true,notifyChannelActivity:true,notifyAgentEvents:true,
  quietHoursStart:'',quietHoursEnd:''};
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function createSettings({store,broadcast,audit,requireWorkspace,requireAdmin,canReadTarget,bodyJSON,asJSON,parseCookie,idHash}){
  const {db,get,all,run}=store;
  db.exec('CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings TEXT NOT NULL)');
  function view(id){return {...defaults,...JSON.parse(get('SELECT settings FROM user_settings WHERE user_id=?',id)?.settings||'{}')};}
  async function api(req,res,url,user){
    if(url.pathname==='/api/account/export'&&req.method==='GET'){
      const workspaces=all('SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=?',user.id);
      const messages=all('SELECT m.* FROM messages m JOIN memberships member ON member.workspace_id=m.workspace_id WHERE member.user_id=? ORDER BY m.created_at',user.id).filter(m=>canReadTarget(user.id,m.target_type,m.target_id));
      asJSON(res,200,{ok:true,exportedAt:now(),user,settings:view(user.id),workspaces,messages,preferences:all('SELECT * FROM preferences WHERE user_id=?',user.id)});return true;
    }
    if(url.pathname==='/api/settings'&&req.method==='PATCH'){
      const input=await bodyJSON(req),next=view(user.id);
      if(input.theme!==undefined){if(!['dark','light'].includes(input.theme))throw fail(400,'Unknown theme');next.theme=input.theme;}
      if(input.density!==undefined){if(!['comfortable','compact'].includes(input.density))throw fail(400,'Unknown density');next.density=input.density;}
      if(input.fontSize!==undefined){if(![12,13,14,16,18].includes(Number(input.fontSize)))throw fail(400,'Choose a supported font size');next.fontSize=Number(input.fontSize);}
      for(const k of ['enterToSend','showTyping','desktopNotifications','notificationSound','onboardingComplete','notifyDirectMessages','notifyMentions','notifyReplies','notifyThreadActivity','notifyChannelActivity','notifyAgentEvents'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw fail(400,'Invalid setting');next[k]=input[k];}
      for(const k of ['quietHoursStart','quietHoursEnd'])if(input[k]!==undefined){
        if(typeof input[k]!=='string'||(input[k]!==''&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input[k])))throw fail(400,'Quiet hours must be a local HH:MM time');
        next[k]=input[k];
      }
      run('INSERT INTO user_settings(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings',user.id,JSON.stringify(next));
      asJSON(res,200,{ok:true,settings:next});return true;
    }
    if(url.pathname==='/api/account/password'&&req.method==='POST'){
      const input=await bodyJSON(req),u=get('SELECT password_hash FROM users WHERE id=?',user.id);
      if(!verifyPassword(String(input.currentPassword||''),u.password_hash))throw fail(400,'Current password is incorrect');
      if(String(input.newPassword||'').length<10)throw fail(400,'New password must have at least 10 characters');
      run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(input.newPassword),user.id);
      const current=idHash(parseCookie(req,'cord_session')||'');run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',user.id,current);
      asJSON(res,200,{ok:true});return true;
    }
    if(url.pathname==='/api/account/sessions'){
      const current=idHash(parseCookie(req,'cord_session')||'');
      if(req.method==='GET'){asJSON(res,200,{ok:true,sessions:all('SELECT token_hash,expires_at FROM sessions WHERE user_id=? AND expires_at>?',user.id,now()).map(s=>({current:s.token_hash===current,expiresAt:s.expires_at}))});return true;}
      if(req.method==='DELETE'){run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',user.id,current);asJSON(res,200,{ok:true});return true;}
    }
    if(url.pathname==='/api/workspace'&&req.method==='PATCH'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);
      const name=String(input.name??ws.name).trim().slice(0,80);if(name.length<2)throw fail(400,'Workspace name must have at least two characters');
      run('UPDATE workspaces SET name=?,icon=? WHERE id=?',name,String(input.icon??ws.icon).slice(0,3),ws.id);audit(user.id,ws.id,'workspace.edit','workspace',ws.id);broadcast(ws.id);asJSON(res,200,{ok:true});return true;
    }
    return false;
  }
  return {view,api};
}
