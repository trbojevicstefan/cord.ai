import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, hashPassword, verifyPassword, uid, now } from './database.mjs';
import { encryptSecret, assertEndpoint, invokeAgent } from './agents.mjs';
import { createBridge } from './bridge.mjs';
import { createSettings } from './settings.mjs';
import { bridgeDownload } from './downloads.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp'};
const isDemo=()=>process.env.CORD_DEMO!=='0' && process.env.NODE_ENV!=='production';
const isAdmin=(m)=>m?.role==='owner'||m?.role==='admin';
const failure=(status,message)=>Object.assign(new Error(message),{status});
const cut=(str,n)=>String(str??'').trim().slice(0,n);
const bool=(value)=>value===true||value===1||value==='1';
const idHash=(value)=>createHash('sha256').update(value).digest('hex');
function asJSON(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
async function bodyJSON(req) {
  let size=0,chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw failure(413,'Request exceeds 2 MB');chunks.push(chunk)}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw failure(400,'Invalid JSON body')}
  if(!result||typeof result!=='object'||Array.isArray(result))throw failure(400,'Expected JSON object');return result;
}

export function createApp({ databasePath=process.env.CORD_DB_PATH||join(ROOT,'data','cord.db'), demo=isDemo() }={}) {
  const store=createDatabase(databasePath,{demo});
  const {get,all,run}=store;
  const listeners=new Set(), pendingAgents=new Set(), throttles=new Map();
  function broadcast(workspaceId, kind='change', payload={}, dmId=null){
    const out=`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
    for(const client of listeners){
      if(client.workspaceId!==workspaceId)continue;
      if(dmId && !canReadTarget(client.userId,'dm',dmId))continue;
      try{client.res.write(out)}catch{listeners.delete(client)}
    }
  }
  function audit(userId,workspaceId,action,targetType,targetId,meta={}){
    run('INSERT INTO audit(id,workspace_id,user_id,action,target_type,target_id,meta,created_at) VALUES(?,?,?,?,?,?,?,?)',uid(),workspaceId,userId,action,targetType,targetId,JSON.stringify(meta),now());
  }
  function parseCookie(req,name){const raw=req.headers.cookie||'';const found=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return found?decodeURIComponent(found.slice(name.length+1)):null}
  function sessionUser(req){
    const token=parseCookie(req,'cord_session');if(!token)return null;
    const row=get('SELECT u.id,u.username,u.display_name,u.avatar,u.color,u.status FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',idHash(token),now());
    return row||null;
  }
  function openSession(res,userId){const token=randomBytes(32).toString('hex');const expires=new Date(Date.now()+30*24*3600*1000).toISOString();run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',idHash(token),userId,expires);res.setHeader('Set-Cookie',`cord_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${process.env.CORD_SECURE_COOKIE==='1'?'; Secure':''}`)}
  function clearSession(req,res){const token=parseCookie(req,'cord_session');if(token)run('DELETE FROM sessions WHERE token_hash=?',idHash(token));res.setHeader('Set-Cookie','cord_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax')}
  function membership(userId,workspaceId){return get('SELECT * FROM memberships WHERE user_id=? AND workspace_id=?',userId,workspaceId)}
  function workspaceFor(userId){return get('SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at LIMIT 1',userId)}
  function requireWorkspace(userId,workspaceId){const ws=workspaceId?get('SELECT * FROM workspaces WHERE id=?',workspaceId):workspaceFor(userId);if(!ws||!membership(userId,ws.id))throw failure(403,'Not a member of this workspace');return ws}
  function requireAdmin(userId,workspaceId){const m=membership(userId,workspaceId);if(!isAdmin(m))throw failure(403,'Only workspace admins can perform this action');return m}
  function canReadTarget(userId,type,id){
    if(type==='channel'){const c=get('SELECT workspace_id FROM channels WHERE id=?',id);return !!c&&!!membership(userId,c.workspace_id)}
    if(type==='thread'){const t=get('SELECT workspace_id FROM threads WHERE id=?',id);return !!t&&!!membership(userId,t.workspace_id)}
    if(type==='dm'){const d=get('SELECT * FROM dms WHERE id=?',id);return !!d && (d.user_id===userId||d.participant_user_id===userId)}
    return false;
  }
  function targetWorkspace(userId,type,id){
    if(!['channel','thread','dm'].includes(type))throw failure(400,'Unknown target type');
    const t=get(`SELECT * FROM ${type==='channel'?'channels':type==='thread'?'threads':'dms'} WHERE id=?`,id);
    if(!t||!membership(userId,t.workspace_id) || (type==='dm'&&!canReadTarget(userId,type,id)))throw failure(404,'Conversation not found');
    return t;
  }
  function recordMessage(ws,type,id,authorType,authorId,content,metadata={}){
    const message={id:uid(),workspace_id:ws,target_type:type,target_id:id,author_type:authorType,author_id:authorId,content:cut(content,24000),metadata:JSON.stringify(metadata),created_at:now()};
    run('INSERT INTO messages(id,workspace_id,target_type,target_id,author_type,author_id,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)',message.id,ws,type,id,authorType,authorId,message.content,message.metadata,message.created_at);
    if(type==='thread')run('UPDATE threads SET updated_at=? WHERE id=?',message.created_at,id);
    broadcast(ws,'change',{scope:type,id,messageId:message.id},type==='dm'?id:null);
    return message;
  }
  // Generic messages cannot have foreign keys to three different target tables;
  // remove dependent events/read state explicitly when a conversation is deleted.
  function purgeConversation(type,id){
    run('DELETE FROM runs WHERE target_type=? AND target_id=?',type,id);
    run('DELETE FROM messages WHERE target_type=? AND target_id=?',type,id);
    run('DELETE FROM reads WHERE target_type=? AND target_id=?',type,id);
    run('DELETE FROM preferences WHERE target_type=? AND target_id=?',type,id);
  }
  function prefs(userId,type,id){return get('SELECT * FROM preferences WHERE user_id=? AND target_type=? AND target_id=?',userId,type,id)||{muted:0,favorite:0,notification_level:'all'}}
  const bridge=createBridge({store,broadcast,recordMessage,audit,requireWorkspace,requireAdmin,canReadTarget,bodyJSON,asJSON});
  const settings=createSettings({store,broadcast,audit,requireWorkspace,requireAdmin,canReadTarget,bodyJSON,asJSON,sessionUser,parseCookie,idHash});
  function agentMatches(agent,text){return text.toLowerCase().includes('@'+agent.name.toLowerCase())||text.toLowerCase().includes(`<@${agent.id.toLowerCase()}>`)}
  async function queueAgent(source, workspaceId, agent) {
    if(agent.type==='bridge'){const history=all('SELECT * FROM messages WHERE target_type=? AND target_id=? AND rowid<=(SELECT rowid FROM messages WHERE id=?) AND author_type<>? ORDER BY rowid DESC LIMIT 24',source.target_type,source.target_id,source.id,'system').reverse();return bridge.enqueue(source,agent,history);}
    const key=`${agent.id}:${source.target_type}:${source.target_id}`;
    const runId=uid();
    if(pendingAgents.has(key))return;
    pendingAgents.add(key);
    run('INSERT INTO runs(id,workspace_id,agent_id,message_id,target_type,target_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',runId,workspaceId,agent.id,source.id,source.target_type,source.target_id,'running',now());
    broadcast(workspaceId,'agent',{status:'running',targetType:source.target_type,targetId:source.target_id,agentId:agent.id,runId},source.target_type==='dm'?source.target_id:null);
    try {
      const history=all('SELECT * FROM messages WHERE target_type=? AND target_id=? AND author_type<>? ORDER BY created_at DESC LIMIT 24',source.target_type,source.target_id,'system').reverse();
      const reply=await invokeAgent(agent,history);
      recordMessage(workspaceId,source.target_type,source.target_id,'agent',agent.id,reply);
      run('UPDATE runs SET status=?,finished_at=? WHERE id=?','completed',now(),runId);
      broadcast(workspaceId,'agent',{status:'completed',targetType:source.target_type,targetId:source.target_id,agentId:agent.id,runId},source.target_type==='dm'?source.target_id:null);
    } catch(err) {
      run('UPDATE runs SET status=?,error=?,finished_at=? WHERE id=?','failed',cut(err.message,300),now(),runId);
      broadcast(workspaceId,'agent',{status:'failed',targetType:source.target_type,targetId:source.target_id,agentId:agent.id,runId,error:cut(err.message,200)},source.target_type==='dm'?source.target_id:null);
    } finally {pendingAgents.delete(key)}
  }
  function routeAgents(message){
    if(message.author_type!=='user')return;
    let matches=[];
    if(message.target_type==='thread'){
      const thread=get('SELECT * FROM threads WHERE id=?',message.target_id);
      if(thread&&!thread.archived&&thread.agent_id&&thread.agent_mode!=='off'){
        const agent=get('SELECT * FROM agents WHERE id=?',thread.agent_id);
        if(agent && (thread.agent_mode==='auto'||agentMatches(agent,message.content)))matches=[agent];
      }
    } else if(message.target_type==='dm'){
      const dm=get('SELECT * FROM dms WHERE id=?',message.target_id);
      if(dm?.participant_agent_id){const a=get('SELECT * FROM agents WHERE id=?',dm.participant_agent_id);if(a)matches=[a]}
    } else if(message.target_type==='channel'){
      matches=all('SELECT * FROM agents WHERE workspace_id=?',message.workspace_id).filter(a=>agentMatches(a,message.content)).slice(0,2);
    }
    // Agent output NEVER triggers another agent. Each human message triggers at most one agent in threads.
    for(const a of matches) void queueAgent(message,message.workspace_id,a);
  }

  async function route(req,res){
    const url=new URL(req.url,'http://localhost');const pathname=url.pathname;
    if(await bridgeDownload(req,res,url,ROOT))return;
    if(pathname==='/api/auth/config'&&req.method==='GET')return asJSON(res,200,{ok:true,setupRequired:!get('SELECT id FROM users LIMIT 1'),demo});
    if(pathname==='/api/health')return asJSON(res,200,{ok:true,service:'cord-ai',mode:demo?'demo':'production'});
    if(!pathname.startsWith('/api/')){
      if(req.method!=='GET'&&req.method!=='HEAD')throw failure(405,'Method not allowed');
      const name=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1));
      const file=resolve(PUBLIC,name),publicRelative=relative(PUBLIC,file);if(publicRelative==='..'||publicRelative.startsWith('..'+sep)||isAbsolute(publicRelative))throw failure(403,'Forbidden');
      try{const info=await stat(file);if(!info.isFile())throw new Error('Not a file');const content=await readFile(file);res.writeHead(200,{'content-type':MIME[extname(file)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'"});return res.end(req.method==='HEAD'?undefined:content)}catch{throw failure(404,'Page not found')}
    }
    if(req.method!=='GET' && req.method!=='HEAD'){
      const origin=req.headers.origin;
      if(origin){let parsed;try{parsed=new URL(origin)}catch{throw failure(403,'Invalid origin')}
        const own=(process.env.CORD_PUBLIC_ORIGIN||`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`).toLowerCase();
        if(parsed.origin.toLowerCase()!==own)throw failure(403,'Cross-origin requests are not allowed');
      }
      const ip=req.socket.remoteAddress||'unknown';const mark=throttles.get(ip)||{n:0,until:0};if(mark.until<Date.now()){mark.n=0;mark.until=Date.now()+10_000}if(++mark.n>120)throw failure(429,'Too many requests');throttles.set(ip,mark);
    }
    if(await bridge.worker(req,res,url))return;
    if(pathname==='/api/auth/demo'&&req.method==='POST'){
      if(!demo)throw failure(404,'Demo login is disabled');const user=get('SELECT * FROM users WHERE id=?','user-stefan');if(!user)throw failure(404,'Demo seed unavailable');openSession(res,user.id);return asJSON(res,200,{ok:true,user:{id:user.id,display_name:user.display_name,username:user.username}});
    }
    if(pathname==='/api/auth/login'&&req.method==='POST'){
      const input=await bodyJSON(req), u=get('SELECT * FROM users WHERE username=?',cut(input.username,80));
      if(!u || !verifyPassword(String(input.password||''),u.password_hash))throw failure(401,'Invalid username or password');
      openSession(res,u.id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/auth/register'&&req.method==='POST'){
      const input=await bodyJSON(req);const username=cut(input.username,50).toLowerCase();const password=String(input.password||'');const display=cut(input.displayName,70)||username;
      if(!/^[a-z0-9_.-]{3,50}$/.test(username)||password.length<10)throw failure(400,'Username must contain 3+ letters/numbers; password must have 10+ characters');
      if(get('SELECT id FROM users WHERE username=?',username))throw failure(409,'Username already exists');
      const first=!get('SELECT id FROM users LIMIT 1');const invite=get('SELECT * FROM invites WHERE code=? AND expires_at>?',cut(input.inviteCode,100),now());
      if(!first&&!invite&&process.env.CORD_OPEN_SIGNUP!=='1')throw failure(403,'An invite is required');
      const id=uid();run('INSERT INTO users(id,username,display_name,password_hash,avatar,color,created_at) VALUES(?,?,?,?,?,?,?)',id,username,display,hashPassword(password),display.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(),'#5865f2',now());
      const ws=first?uid():(invite?.workspace_id||workspaceFor(get('SELECT id FROM users LIMIT 1').id)?.id);
      if(first){run('INSERT INTO workspaces(id,name,icon,created_at) VALUES(?,?,?,?)',ws,'My Team','C',now());const cat=uid();run('INSERT INTO categories(id,workspace_id,name,position) VALUES(?,?,?,?)',cat,ws,'TEXT CHANNELS',0);run('INSERT INTO channels(id,workspace_id,category_id,name,description,position,created_at) VALUES(?,?,?,?,?,?,?)',uid(),ws,cat,'general','Welcome to your workspace',0,now())}
      if(!ws)throw failure(400,'Workspace unavailable');run('INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?)',ws,id,first?'owner':'member');if(invite)run('DELETE FROM invites WHERE code=?',invite.code);
      openSession(res,id);return asJSON(res,201,{ok:true,userId:id});
    }
    const user=sessionUser(req);
    if(!user)throw failure(401,'Please sign in');
    if(await bridge.api(req,res,url,user)||await settings.api(req,res,url,user))return;
    if(pathname==='/api/auth/logout'&&req.method==='POST'){clearSession(req,res);return asJSON(res,200,{ok:true})}
    if(pathname==='/api/me'&&req.method==='GET')return asJSON(res,200,{ok:true,user,demo});
    if(pathname==='/api/bootstrap'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));
      const categories=all('SELECT * FROM categories WHERE workspace_id=? ORDER BY position,name',ws.id), channels=all('SELECT * FROM channels WHERE workspace_id=? ORDER BY position,name',ws.id);
      const threads=all('SELECT * FROM threads WHERE workspace_id=? ORDER BY updated_at DESC',ws.id);
      const agents=all('SELECT id,workspace_id,name,avatar,color,description,type,status,endpoint,model,external_id,created_at FROM agents WHERE workspace_id=? ORDER BY name',ws.id).map(bridge.view);
      const members=all('SELECT u.id,u.display_name,u.username,u.avatar,u.color,u.status,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? ORDER BY u.display_name',ws.id);
      const dms=all('SELECT * FROM dms WHERE workspace_id=? AND (user_id=? OR participant_user_id=?) ORDER BY created_at DESC',ws.id,user.id,user.id);
      const preferences=all('SELECT * FROM preferences WHERE user_id=?',user.id);
      const reads=all('SELECT * FROM reads WHERE user_id=?',user.id);
      const runs=all('SELECT r.id,r.agent_id,r.target_type,r.target_id,r.status,r.error,r.created_at,r.finished_at,j.progress FROM runs r LEFT JOIN bridge_jobs j ON j.id=r.id WHERE r.workspace_id=? ORDER BY r.rowid DESC LIMIT 50',ws.id).filter(r=>canReadTarget(user.id,r.target_type,r.target_id));
      return asJSON(res,200,{ok:true,user,workspace:ws,categories,channels,threads,members,agents,dms,preferences,reads,runs,demo,settings:settings.view(user.id),workspaces:all('SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=?',user.id),approvals:bridge.approvals(user,ws.id)});
    }
    if(pathname==='/api/events'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
      res.write('retry: 1500\nevent: ready\ndata: {}\n\n');
      const client={res,userId:user.id,workspaceId:ws.id};listeners.add(client);
      const heartbeat=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},22_000);
      req.on('close',()=>{clearInterval(heartbeat);listeners.delete(client)});return;
    }
    if(pathname==='/api/messages'&&req.method==='GET'){
      const type=url.searchParams.get('type'),id=url.searchParams.get('id');targetWorkspace(user.id,type,id);
      const messages=all('SELECT * FROM (SELECT * FROM messages WHERE target_type=? AND target_id=? ORDER BY created_at DESC,id DESC LIMIT 150) ORDER BY created_at,id',type,id);
      return asJSON(res,200,{ok:true,messages});
    }
    if(pathname==='/api/messages'&&req.method==='POST'){
      const input=await bodyJSON(req);const type=cut(input.targetType,20),id=cut(input.targetId,100),content=cut(input.content,24000);
      if(!content)throw failure(400,'Message cannot be empty');const target=targetWorkspace(user.id,type,id);
      if(type==='thread'){
        if(target.archived)throw failure(403,'This thread is closed');
        if(target.locked&&!isAdmin(membership(user.id,target.workspace_id))&&target.author_id!==user.id)throw failure(403,'This thread is locked');
        if(target.slowmode>0&&!isAdmin(membership(user.id,target.workspace_id))){
          const last=get('SELECT created_at FROM messages WHERE target_type=? AND target_id=? AND author_type=? AND author_id=? ORDER BY created_at DESC LIMIT 1','thread',id,'user',user.id);
          if(last && (Date.now()-Date.parse(last.created_at))<target.slowmode*1000)throw failure(429,`Slowmode: wait ${target.slowmode} seconds between messages`);
        }
        run('INSERT OR IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)',id,user.id);
      }
      const message=recordMessage(target.workspace_id,type,id,'user',user.id,content);
      audit(user.id,target.workspace_id,'message.create',type,id);
      routeAgents(message);
      return asJSON(res,201,{ok:true,message});
    }
    const delMessage=pathname.match(/^\/api\/messages\/([^/]+)$/);
    if(delMessage && req.method==='DELETE'){
      const message=get('SELECT * FROM messages WHERE id=?',delMessage[1]);if(!message)throw failure(404,'Message not found');
      targetWorkspace(user.id,message.target_type,message.target_id);
      if(message.author_id!==user.id&&!isAdmin(membership(user.id,message.workspace_id)))throw failure(403,'Cannot delete another member’s message');
      run('DELETE FROM messages WHERE id=?',message.id);audit(user.id,message.workspace_id,'message.delete',message.target_type,message.target_id);broadcast(message.workspace_id,'change',{scope:message.target_type,id:message.target_id},message.target_type==='dm'?message.target_id:null);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/search'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));const q=cut(url.searchParams.get('q'),80);
      if(q.length<2)return asJSON(res,200,{ok:true,messages:[]});
      const matches=all('SELECT * FROM messages WHERE workspace_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 60',ws.id,`%${q.replace(/[%_]/g,'')}%`).filter(m=>m.target_type!=='dm'||canReadTarget(user.id,'dm',m.target_id));
      return asJSON(res,200,{ok:true,messages:matches});
    }
    if(pathname==='/api/categories'&&req.method==='POST'){
      const input=await bodyJSON(req);const ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);const name=cut(input.name,70);if(!name)throw failure(400,'Category name is required');const id=uid();run('INSERT INTO categories(id,workspace_id,name,position) VALUES(?,?,?,?)',id,ws.id,name,all('SELECT id FROM categories WHERE workspace_id=?',ws.id).length);audit(user.id,ws.id,'category.create','category',id);broadcast(ws.id);return asJSON(res,201,{ok:true,id});
    }
    const categoryRoute=pathname.match(/^\/api\/categories\/([^/]+)$/);
    if(categoryRoute&&['PATCH','DELETE'].includes(req.method)){
      const c=get('SELECT * FROM categories WHERE id=?',categoryRoute[1]);if(!c)throw failure(404,'Category not found');requireWorkspace(user.id,c.workspace_id);requireAdmin(user.id,c.workspace_id);
      if(req.method==='DELETE'){run('DELETE FROM preferences WHERE target_type=? AND target_id=?','category',c.id);run('DELETE FROM categories WHERE id=?',c.id)}else{const input=await bodyJSON(req);run('UPDATE categories SET name=?,position=? WHERE id=?',cut(input.name??c.name,70),Number.isInteger(input.position)?input.position:c.position,c.id)}
      audit(user.id,c.workspace_id,`category.${req.method.toLowerCase()}`,'category',c.id);broadcast(c.workspace_id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/channels'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);const name=cut(input.name,60).toLowerCase().replace(/\s+/g,'-');if(!/^[a-z0-9_\-]{2,60}$/.test(name))throw failure(400,'Channel name must be 2–60 characters');
      const cat=input.categoryId?get('SELECT * FROM categories WHERE id=? AND workspace_id=?',input.categoryId,ws.id):null;
      if(input.categoryId&&!cat)throw failure(404,'Category not found');const id=uid();run('INSERT INTO channels(id,workspace_id,category_id,name,description,position,created_at) VALUES(?,?,?,?,?,?,?)',id,ws.id,cat?.id||null,name,cut(input.description,400),all('SELECT id FROM channels WHERE workspace_id=?',ws.id).length,now());audit(user.id,ws.id,'channel.create','channel',id);broadcast(ws.id);return asJSON(res,201,{ok:true,id});
    }
    const channelRoute=pathname.match(/^\/api\/channels\/([^/]+)$/);
    if(channelRoute&&['PATCH','DELETE'].includes(req.method)){
      const c=get('SELECT * FROM channels WHERE id=?',channelRoute[1]);if(!c)throw failure(404,'Channel not found');requireWorkspace(user.id,c.workspace_id);requireAdmin(user.id,c.workspace_id);
      if(req.method==='DELETE'){for(const t of all('SELECT id FROM threads WHERE channel_id=?',c.id))purgeConversation('thread',t.id);purgeConversation('channel',c.id);run('DELETE FROM channels WHERE id=?',c.id)}else{
        const input=await bodyJSON(req);const cat=input.categoryId===null?null:(input.categoryId??c.category_id);
        if(cat&&!get('SELECT id FROM categories WHERE id=? AND workspace_id=?',cat,c.workspace_id))throw failure(404,'Category not found');
        run('UPDATE channels SET name=?,description=?,category_id=? WHERE id=?',cut(input.name??c.name,60),cut(input.description??c.description,400),cat,c.id);
      }
      audit(user.id,c.workspace_id,`channel.${req.method.toLowerCase()}`,'channel',c.id);broadcast(c.workspace_id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/threads'&&req.method==='POST'){
      const input=await bodyJSON(req);const channel=targetWorkspace(user.id,'channel',cut(input.channelId,100));const name=cut(input.name,120);if(name.length<2)throw failure(400,'Thread name must have at least 2 characters');
      const agent=input.agentId?get('SELECT id FROM agents WHERE id=? AND workspace_id=?',input.agentId,channel.workspace_id):null;if(input.agentId&&!agent)throw failure(400,'Unknown agent');
      const source=input.sourceMessageId?get('SELECT * FROM messages WHERE id=? AND workspace_id=? AND target_type=? AND target_id=?',cut(input.sourceMessageId,100),channel.workspace_id,'channel',channel.id):null;
      if(input.sourceMessageId&&(!source||source.author_type==='system'))throw failure(400,'Choose a message from this channel');
      const sourceMeta=source?JSON.parse(source.metadata||'{}'):{};
      if(sourceMeta.thread_ref&&get('SELECT id FROM threads WHERE id=?',sourceMeta.thread_ref))throw failure(409,'This message already has a thread');
      const id=uid(),date=now();run('INSERT INTO threads(id,workspace_id,channel_id,author_id,name,created_at,updated_at,agent_id,agent_mode) VALUES(?,?,?,?,?,?,?,?,?)',id,channel.workspace_id,channel.id,user.id,name,date,date,agent?.id||null,['auto','mentions','off'].includes(input.agentMode)?input.agentMode:'mentions');
      run('INSERT INTO thread_members(thread_id,user_id) VALUES(?,?)',id,user.id);
      if(source){
        recordMessage(channel.workspace_id,'thread',id,source.author_type,source.author_id,source.content,{source_message_id:source.id,source_channel_id:channel.id});
        run('UPDATE messages SET metadata=? WHERE id=?',JSON.stringify({...sourceMeta,thread_ref:id}),source.id);
      }
      recordMessage(channel.workspace_id,'channel',channel.id,'system',user.id,`started a thread: ${name}`,{thread_ref:id});
      if(cut(input.firstMessage,24000))recordMessage(channel.workspace_id,'thread',id,'user',user.id,cut(input.firstMessage,24000));
      audit(user.id,channel.workspace_id,'thread.create','thread',id);broadcast(channel.workspace_id);return asJSON(res,201,{ok:true,id});
    }
    const threadRoute=pathname.match(/^\/api\/threads\/([^/]+)$/);
    if(threadRoute&&['PATCH','DELETE'].includes(req.method)){
      const t=get('SELECT * FROM threads WHERE id=?',threadRoute[1]);if(!t)throw failure(404,'Thread not found');requireWorkspace(user.id,t.workspace_id);const m=membership(user.id,t.workspace_id);if(!isAdmin(m)&&t.author_id!==user.id)throw failure(403,'Only the thread creator or an admin can edit this thread');
      if(req.method==='DELETE'){purgeConversation('thread',t.id);run('DELETE FROM threads WHERE id=?',t.id);audit(user.id,t.workspace_id,'thread.delete','thread',t.id);broadcast(t.workspace_id);return asJSON(res,200,{ok:true})}
      const input=await bodyJSON(req);if(input.agentId && !get('SELECT id FROM agents WHERE id=? AND workspace_id=?',input.agentId,t.workspace_id))throw failure(400,'Agent not found');
      const name=cut(input.name??t.name,120);if(!name)throw failure(400,'Thread name is required');
      const slowmode=[0,5,10,15,30,60,300,900,3600].includes(Number(input.slowmode))?Number(input.slowmode):t.slowmode;
      const autoHide=[1,3,7,30].includes(Number(input.autoHideDays))?Number(input.autoHideDays):t.auto_hide_days;
      const mode=['auto','mentions','off'].includes(input.agentMode)?input.agentMode:t.agent_mode;
      run('UPDATE threads SET name=?,slowmode=?,auto_hide_days=?,spoiler=?,archived=?,locked=?,agent_id=?,agent_mode=?,updated_at=? WHERE id=?',name,slowmode,autoHide,input.spoiler===undefined?t.spoiler:Number(bool(input.spoiler)),input.archived===undefined?t.archived:Number(bool(input.archived)),input.locked===undefined?t.locked:Number(bool(input.locked)),input.agentId===undefined?t.agent_id:(input.agentId||null),mode,now(),t.id);
      audit(user.id,t.workspace_id,'thread.edit','thread',t.id);broadcast(t.workspace_id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/thread-actions'&&req.method==='POST'){
      const input=await bodyJSON(req);const t=targetWorkspace(user.id,'thread',cut(input.threadId,100));const m=membership(user.id,t.workspace_id);const action=cut(input.action,30);
      if(action==='join')run('INSERT OR IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)',t.id,user.id);
      else if(action==='leave')run('DELETE FROM thread_members WHERE thread_id=? AND user_id=?',t.id,user.id);
      else if(['close','reopen','lock','unlock'].includes(action)){
        if(!isAdmin(m)&&t.author_id!==user.id)throw failure(403,'Only a thread owner or admin can change thread status');
        const column=action==='close'||action==='reopen'?'archived':'locked';run(`UPDATE threads SET ${column}=?,updated_at=? WHERE id=?`,['close','lock'].includes(action)?1:0,now(),t.id);
      }else throw failure(400,'Unknown thread action');
      audit(user.id,t.workspace_id,`thread.${action}`,'thread',t.id);broadcast(t.workspace_id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/preferences'&&req.method==='POST'){
      const input=await bodyJSON(req),type=cut(input.targetType,20),id=cut(input.targetId,100);
      let target;if(type==='category'){target=get('SELECT * FROM categories WHERE id=?',id);if(!target)throw failure(404,'Category not found');requireWorkspace(user.id,target.workspace_id)}
      else target=targetWorkspace(user.id,type,id);
      const existing=prefs(user.id,type,id);
      const muted=input.muted===undefined?existing.muted:Number(bool(input.muted));
      const favorite=input.favorite===undefined?existing.favorite:Number(bool(input.favorite));
      const notif=['all','mentions','none'].includes(input.notificationLevel)?input.notificationLevel:existing.notification_level;
      run('INSERT INTO preferences(user_id,target_type,target_id,muted,favorite,notification_level) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,target_type,target_id) DO UPDATE SET muted=excluded.muted,favorite=excluded.favorite,notification_level=excluded.notification_level',user.id,type,id,muted,favorite,notif);
      broadcast(target.workspace_id,'change',{scope:'preferences',userId:user.id});return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/read'&&req.method==='POST'){
      const input=await bodyJSON(req),type=cut(input.targetType,20),id=cut(input.targetId,100),target=targetWorkspace(user.id,type,id);
      run('INSERT INTO reads(user_id,target_type,target_id,last_read_at) VALUES(?,?,?,?) ON CONFLICT(user_id,target_type,target_id) DO UPDATE SET last_read_at=excluded.last_read_at',user.id,type,id,now());
      return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/dms'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);const a=input.agentId?get('SELECT * FROM agents WHERE id=? AND workspace_id=?',input.agentId,ws.id):null;const peer=input.userId?get('SELECT * FROM memberships WHERE user_id=? AND workspace_id=?',input.userId,ws.id):null;
      if(!a&&!peer)throw failure(400,'Choose a teammate or agent');
      if(peer?.user_id===user.id)throw failure(400,'Cannot DM yourself');
      const found=a?get('SELECT * FROM dms WHERE user_id=? AND participant_agent_id=?',user.id,a.id):get('SELECT * FROM dms WHERE (user_id=? AND participant_user_id=?) OR (user_id=? AND participant_user_id=?)',user.id,peer.user_id,peer.user_id,user.id);
      if(found)return asJSON(res,200,{ok:true,id:found.id});
      const id=uid();run('INSERT INTO dms(id,workspace_id,user_id,participant_user_id,participant_agent_id,created_at) VALUES(?,?,?,?,?,?)',id,ws.id,user.id,peer?.user_id||null,a?.id||null,now());audit(user.id,ws.id,'dm.create','dm',id);broadcast(ws.id);return asJSON(res,201,{ok:true,id});
    }
    if(pathname==='/api/invites'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);const code=randomBytes(12).toString('hex');run('INSERT INTO invites(code,workspace_id,created_by,expires_at) VALUES(?,?,?,?)',code,ws.id,user.id,new Date(Date.now()+7*24*3600*1000).toISOString());audit(user.id,ws.id,'invite.create','workspace',ws.id);return asJSON(res,201,{ok:true,code});
    }
    if(pathname==='/api/agents'&&req.method==='POST'){
      const input=await bodyJSON(req),ws=requireWorkspace(user.id,input.workspaceId);requireAdmin(user.id,ws.id);
      const type=cut(input.type,25)||'demo';if(!['demo','openai','opaya','webhook'].includes(type))throw failure(400,'Unsupported connector type');
      const name=cut(input.name,65);if(name.length<2)throw failure(400,'Agent name must have 2+ characters');
      const endpoint=cut(input.endpoint,600);if(type!=='demo')assertEndpoint(endpoint);
      if((type==='opaya'||type==='webhook')&&!input.secret)throw failure(400,'Bridge and webhook connectors need a shared secret');
      const encrypted=encryptSecret(cut(input.secret,2000));const id=uid();
      run('INSERT INTO agents(id,workspace_id,name,avatar,color,description,type,status,endpoint,model,external_id,secret_encrypted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,ws.id,name,name.slice(0,1).toUpperCase(),'#55a6c6',cut(input.description,500),type,type==='demo'?'online':'idle',endpoint,cut(input.model,120),cut(input.externalId,200),encrypted,now());
      audit(user.id,ws.id,'agent.create','agent',id,{type});broadcast(ws.id);return asJSON(res,201,{ok:true,id});
    }
    const agentRoute=pathname.match(/^\/api\/agents\/([^/]+)$/);
    if(agentRoute&&['PATCH','DELETE'].includes(req.method)){
      const agent=get('SELECT * FROM agents WHERE id=?',agentRoute[1]);if(!agent)throw failure(404,'Agent not found');requireWorkspace(user.id,agent.workspace_id);requireAdmin(user.id,agent.workspace_id);
      if(req.method==='DELETE'){run('UPDATE threads SET agent_id=NULL WHERE agent_id=?',agent.id);for(const dm of all('SELECT id FROM dms WHERE participant_agent_id=?',agent.id))purgeConversation('dm',dm.id);run('DELETE FROM dms WHERE participant_agent_id=?',agent.id);run('DELETE FROM agents WHERE id=?',agent.id);audit(user.id,agent.workspace_id,'agent.delete','agent',agent.id);broadcast(agent.workspace_id);return asJSON(res,200,{ok:true})}
      if(agent.type==='bridge')throw failure(400,'Use connection settings for a paired agent');
      const input=await bodyJSON(req);const type=cut(input.type??agent.type,25);if(!['demo','openai','opaya','webhook'].includes(type))throw failure(400,'Unknown connector type');
      const endpoint=cut(input.endpoint??agent.endpoint,600);if(type!=='demo')assertEndpoint(endpoint);
      const sec=input.secret?encryptSecret(cut(input.secret,2000)):agent.secret_encrypted;
      run('UPDATE agents SET name=?,description=?,type=?,endpoint=?,model=?,external_id=?,secret_encrypted=? WHERE id=?',cut(input.name??agent.name,65),cut(input.description??agent.description,500),type,endpoint,cut(input.model??agent.model,120),cut(input.externalId??agent.external_id,200),sec,agent.id);
      audit(user.id,agent.workspace_id,'agent.edit','agent',agent.id);broadcast(agent.workspace_id);return asJSON(res,200,{ok:true});
    }
    if(pathname==='/api/runs'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));const rows=all('SELECT * FROM runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50',ws.id);
      return asJSON(res,200,{ok:true,runs:rows.filter(r=>canReadTarget(user.id,r.target_type,r.target_id))});
    }
    if(pathname==='/api/audit'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));requireAdmin(user.id,ws.id);return asJSON(res,200,{ok:true,events:all('SELECT * FROM audit WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100',ws.id)});
    }
    if(pathname==='/api/profile'&&req.method==='PATCH'){
      const input=await bodyJSON(req);const display=cut(input.displayName??user.display_name,70);if(!display)throw failure(400,'Name required');
      const status=['online','idle','busy','invisible'].includes(input.status)?input.status:user.status;
      run('UPDATE users SET display_name=?,status=? WHERE id=?',display,status,user.id);
      for(const ws of all('SELECT workspace_id FROM memberships WHERE user_id=?',user.id))broadcast(ws.workspace_id);
      return asJSON(res,200,{ok:true});
    }
    throw failure(404,'API endpoint not found');
  }
  const server=http.createServer((req,res)=>{void route(req,res).catch(error=>{if(res.headersSent){try{res.end()}catch{}return;}const status=error.status||500;if(status>=500)console.error('Cord server error:',error);asJSON(res,status,{ok:false,error:status>=500?'Internal error':error.message})})});
  server.on('close',()=>{bridge.close();for(const c of listeners){try{c.res.end()}catch{}};store.close()});
  return {server,store};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (existsSync(join(ROOT,'.env'))) process.loadEnvFile(join(ROOT,'.env'));
  if(!process.env.CORD_MASTER_KEY){const directory=join(ROOT,'data');mkdirSync(directory,{recursive:true,mode:0o700});const keyFile=join(directory,'master.key');if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});process.env.CORD_MASTER_KEY=readFileSync(keyFile,'utf8').trim();}
  const {server}=createApp();const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
  server.listen(port,host,()=>console.log(`Cord AI running at http://${host}:${server.address().port} (${isDemo()?'DEMO':'PRODUCTION'} mode)`));
}
