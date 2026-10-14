import { uid, now } from './database.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const short=(value,length=180)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,length);
const kinds=new Set(['mention','reply','dm','thread','channel','agent_error','agent_approval']);
const defaults={
  notifyDirectMessages:true, notifyMentions:true, notifyReplies:true,
  notifyThreadActivity:true, notifyChannelActivity:true, notifyAgentEvents:true,
  quietHoursStart:'',quietHoursEnd:''
};

/** Persistent, strictly per-recipient notifications. No credentials or full messages are exposed in SSE. */
export function createNotifications({store,canReadTarget,requireWorkspace,bodyJSON,asJSON,sendUser}) {
  const {db,get,all,run}=store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      target_type TEXT,
      target_id TEXT,
      message_id TEXT,
      run_id TEXT,
      title TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      read_at TEXT,
      dismissed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_per_message
      ON notifications(user_id,message_id) WHERE message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_per_run_kind
      ON notifications(user_id,run_id,kind) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS notifications_inbox
      ON notifications(user_id,workspace_id,dismissed_at,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS notifications_target
      ON notifications(user_id,target_type,target_id);
  `);

  function settings(userId) {
    const row=get('SELECT settings FROM user_settings WHERE user_id=?',userId);
    if(!row)return {...defaults};
    try {return {...defaults,...JSON.parse(row.settings)}}catch{return {...defaults}}
  }
  function visible(userId,item){
    if(!item)return false;
    // Approval notifications are tied to a conversation and therefore use its ACL.
    return Boolean(item.target_type&&item.target_id&&canReadTarget(userId,item.target_type,item.target_id));
  }
  function summary(userId,workspaceId) {
    const rows=all('SELECT id,kind,target_type,target_id,read_at FROM notifications WHERE user_id=? AND workspace_id=? AND dismissed_at IS NULL AND read_at IS NULL ORDER BY created_at DESC LIMIT 1500',userId,workspaceId);
    const out={unread:0,mentions:0,dms:0,agents:0};
    for(const row of rows){if(!visible(userId,row))continue;out.unread++;if(row.kind==='mention')out.mentions++;if(row.kind==='dm')out.dms++;if(row.kind.startsWith('agent_'))out.agents++}
    return out;
  }
  function publish(userId,workspaceId,event='changed',id=''){
    sendUser(userId,workspaceId,{event,id,summary:summary(userId,workspaceId)});
  }
  function muted(userId,workspaceId,type,id){
    const prefs=all('SELECT target_type,target_id,muted,notification_level FROM preferences WHERE user_id=?',userId);
    const pref=(kind,key)=>prefs.find(x=>x.target_type===kind&&x.target_id===key);
    const current=pref(type,id);
    if(current?.muted||current?.notification_level==='none')return {blocked:true,level:'none',explicit:!!current};
    let channelId=type==='channel'?id:null;
    if(type==='thread')channelId=get('SELECT channel_id FROM threads WHERE id=? AND workspace_id=?',id,workspaceId)?.channel_id;
    if(channelId){
      const p=pref('channel',channelId);
      if(p?.muted||p?.notification_level==='none')return {blocked:true,level:'none',explicit:!!current};
      const categoryId=get('SELECT category_id FROM channels WHERE id=? AND workspace_id=?',channelId,workspaceId)?.category_id;
      if(categoryId){const c=pref('category',categoryId);if(c?.muted||c?.notification_level==='none')return {blocked:true,level:'none',explicit:!!current}}
    }
    return {blocked:false,level:current?.notification_level||'default',explicit:!!current};
  }
  function recipientOk(userId,workspaceId,type,id,kind){
    if(!get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',workspaceId,userId))return false;
    if(!canReadTarget(userId,type,id))return false;
    const prefs=settings(userId);
    const key={dm:'notifyDirectMessages',mention:'notifyMentions',reply:'notifyReplies',thread:'notifyThreadActivity',channel:'notifyChannelActivity',agent_error:'notifyAgentEvents',agent_approval:'notifyAgentEvents'}[kind];
    if(key&&prefs[key]===false)return false;
    const policy=muted(userId,workspaceId,type,id);
    if(policy.blocked)return false;
    // "Mentions only" means replies or explicit mentions, not general traffic.
    if(['thread','channel'].includes(kind)&&policy.level==='mentions')return false;
    return true;
  }
  function insert(recipient,message,kind,{title,preview,runId}={}){
    if(!kinds.has(kind))throw fail(500,'Unknown notification type');
    const messageId=message?.id||null;
    const workspaceId=message.workspace_id,userId=recipient;
    const type=message.target_type,id=message.target_id;
    if(!recipientOk(userId,workspaceId,type,id,kind))return false;
    const notificationId=uid(), timestamp=now();
    const result=run(`INSERT OR IGNORE INTO notifications
      (id,workspace_id,user_id,kind,actor_type,actor_id,target_type,target_id,message_id,run_id,title,preview,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,notificationId,workspaceId,userId,kind,
      message.author_type||'system',message.author_id||'',type,id,messageId,runId||null,
      short(title||'New activity',160),short(preview??message.content??'',260),timestamp);
    if(result.changes){publish(userId,workspaceId,'created',notificationId);return true}
    return false;
  }
  function onMessage(message,{mentions=[],replyTo=null}={}){
    if(message.author_type==='system')return 0;
    const ws=message.workspace_id,author=message.author_type==='user'?message.author_id:null;
    const recipients=new Map();
    const offer=(recipient,kind)=>{
      if(!recipient||recipient===author)return;
      const ranking={channel:1,thread:1,dm:2,reply:3,mention:4};
      const old=recipients.get(recipient);
      if(!old||ranking[kind]>ranking[old])recipients.set(recipient,kind);
    };
    if(message.target_type==='dm'){
      const d=get('SELECT user_id,participant_user_id FROM dms WHERE id=? AND workspace_id=?',message.target_id,ws);
      if(d){offer(d.user_id,'dm');offer(d.participant_user_id,'dm')}
    }
    if(message.target_type==='thread'){
      const thread=get('SELECT author_id FROM threads WHERE id=? AND workspace_id=?',message.target_id,ws);
      if(thread){offer(thread.author_id,'thread');for(const u of all('SELECT user_id FROM thread_members WHERE thread_id=?',message.target_id))offer(u.user_id,'thread');for(const pref of all("SELECT user_id FROM preferences WHERE target_type='thread' AND target_id=? AND notification_level='all' AND muted=0",message.target_id))offer(pref.user_id,'thread')}
    }
    if(message.target_type==='channel'){
      // Public channels notify everybody only if they explicitly opted into "All messages".
      for(const pref of all("SELECT user_id FROM preferences WHERE target_type='channel' AND target_id=? AND notification_level='all' AND muted=0",message.target_id))offer(pref.user_id,'channel');
      const categoryId=get('SELECT category_id FROM channels WHERE id=? AND workspace_id=?',message.target_id,ws)?.category_id;
      if(categoryId)for(const pref of all("SELECT user_id FROM preferences WHERE target_type='category' AND target_id=? AND notification_level='all' AND muted=0",categoryId))offer(pref.user_id,'channel');
    }
    if(replyTo){const original=get('SELECT author_type,author_id,target_type,target_id FROM messages WHERE id=?',replyTo);if(original?.author_type==='user'&&original.target_type===message.target_type&&original.target_id===message.target_id)offer(original.author_id,'reply')}
    if(message.author_type==='agent'||message.author_type==='user'){
      // User mentions were already validated by social.prepareMessage; for agent messages,
      // limit notifications to real members of this workspace.
      const ids=message.author_type==='agent'?Array.from(String(message.content).matchAll(/<@([a-zA-Z0-9_-]{1,100})>/g),m=>m[1]):mentions;
      for(const mentioned of ids)offer(mentioned,'mention');
    }
    const name=message.author_type==='agent'?get('SELECT name FROM agents WHERE id=? AND workspace_id=?',message.author_id,ws)?.name:
      get('SELECT display_name FROM users WHERE id=?',message.author_id)?.display_name;
    const actor=name||'Teammate';let created=0;
    for(const [recipient,kind] of recipients){
      const title={dm:`${actor} sent you a message`,mention:`${actor} mentioned you`,reply:`${actor} replied to you`,thread:`New message in a thread`,channel:`New channel message`}[kind];
      created+=Number(insert(recipient,message,kind,{title}));
    }
    return created;
  }
  function onEditedMentions(message,oldIds=[]){
    const current=all('SELECT user_id FROM message_mentions WHERE message_id=?',message.id).map(x=>x.user_id);
    let count=0;for(const userId of current){
      if(oldIds.includes(userId)||userId===message.author_id)continue;
      const existing=get('SELECT id,dismissed_at FROM notifications WHERE user_id=? AND message_id=?',userId,message.id);
      if(existing){
        if(!existing.dismissed_at&&recipientOk(userId,message.workspace_id,message.target_type,message.target_id,'mention')){
          run('UPDATE notifications SET kind=?,title=?,read_at=NULL WHERE id=?','mention','You were mentioned in an edited message',existing.id);
          publish(userId,message.workspace_id,'changed',existing.id);count++;
        }
      }else count+=Number(insert(userId,message,'mention',{title:'You were mentioned in an edited message'}));
    }
    return count;
  }
  function onAgentEvent(workspaceId,payload){
    if(payload.status!=='failed'||!payload.runId)return 0;
    const r=get('SELECT message_id,agent_id,target_type,target_id FROM runs WHERE id=? AND workspace_id=?',payload.runId,workspaceId);
    if(!r)return 0;
    const source=get('SELECT author_type,author_id FROM messages WHERE id=?',r.message_id);
    if(source?.author_type!=='user')return 0;
    return Number(insert(source.author_id,{workspace_id:workspaceId,author_type:'agent',author_id:r.agent_id||'',target_type:r.target_type,target_id:r.target_id,content:short(payload.error||'Agent run failed',260)},'agent_error',{title:'An agent run failed',runId:payload.runId}));
  }
  function onApproval(workspaceId,{approvalId,runId,targetType,targetId}){
    const approval=get('SELECT title FROM bridge_approvals WHERE id=?',approvalId);
    const job=get('SELECT agent_id FROM runs WHERE id=? AND workspace_id=?',runId,workspaceId);
    if(!approval||!job)return 0;
    const message={workspace_id:workspaceId,author_type:'agent',author_id:job.agent_id||'',target_type:targetType,target_id:targetId,content:approval.title||'An agent needs approval'};
    let count=0;
    for(const recipient of all("SELECT user_id FROM memberships WHERE workspace_id=? AND role IN ('owner','admin')",workspaceId)){
      count+=Number(insert(recipient.user_id,message,'agent_approval',{title:'Agent action requires approval',runId}));
    }
    return count;
  }
  function purgeMessage(messageId){run('DELETE FROM notifications WHERE message_id=?',messageId)}
  function purgeConversation(type,id){run('DELETE FROM notifications WHERE target_type=? AND target_id=?',type,id)}
  function markTarget(userId,workspaceId,type,id){
    if(!canReadTarget(userId,type,id))throw fail(404,'Conversation not found');
    const result=run('UPDATE notifications SET read_at=? WHERE user_id=? AND workspace_id=? AND target_type=? AND target_id=? AND read_at IS NULL AND dismissed_at IS NULL',now(),userId,workspaceId,type,id);
    if(result.changes)publish(userId,workspaceId,'read');return result.changes;
  }
  async function api(req,res,url,user){
    const path=url.pathname;if(!path.startsWith('/api/notifications'))return false;
    const input=req.method==='GET'?{}:await bodyJSON(req);
    const ws=requireWorkspace(user.id,(req.method==='GET'?url.searchParams.get('workspaceId'):input.workspaceId)||null);
    if(path==='/api/notifications/summary'&&req.method==='GET'){asJSON(res,200,{ok:true,summary:summary(user.id,ws.id)});return true}
    if(path==='/api/notifications'&&req.method==='GET'){
      const kind=url.searchParams.get('filter')||'all';if(!['all','unread','mentions','agents'].includes(kind))throw fail(400,'Unknown filter');
      const limit=Math.min(50,Math.max(5,Number(url.searchParams.get('limit')||25)||25));
      const token=url.searchParams.get('before');let cursor=null;
      if(token){try{cursor=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));if(!Array.isArray(cursor)||cursor.length!==2||!/^\d{4}-\d\d-\d\dT/.test(cursor[0])||typeof cursor[1]!=='string')throw Error()}catch{throw fail(400,'Invalid pagination cursor')}}
      const filters={all:'',unread:'AND read_at IS NULL',mentions:"AND kind IN ('mention','reply')",agents:"AND kind IN ('agent_error','agent_approval')"};
      const sql=`SELECT id,workspace_id,kind,actor_type,actor_id,target_type,target_id,message_id,run_id,title,preview,created_at,read_at
        FROM notifications WHERE user_id=? AND workspace_id=? AND dismissed_at IS NULL ${filters[kind]}
        ${cursor?'AND (created_at<? OR (created_at=? AND id<?))':''}
        ORDER BY created_at DESC,id DESC LIMIT ?`;
      const params=[user.id,ws.id,...(cursor?[cursor[0],cursor[0],cursor[1]]:[]),limit+1];
      const rows=all(sql,...params).filter(row=>visible(user.id,row));const hasMore=rows.length>limit;const items=rows.slice(0,limit),last=items.at(-1);
      asJSON(res,200,{ok:true,items,summary:summary(user.id,ws.id),nextCursor:hasMore&&last?Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url'):null});return true;
    }
    if(path==='/api/notifications/read-all'&&req.method==='POST'){
      const rows=all('SELECT id,target_type,target_id FROM notifications WHERE user_id=? AND workspace_id=? AND read_at IS NULL AND dismissed_at IS NULL',user.id,ws.id);
      let count=0;for(const row of rows){if(visible(user.id,row)){run('UPDATE notifications SET read_at=? WHERE id=?',now(),row.id);count++}}
      if(count)publish(user.id,ws.id,'read');asJSON(res,200,{ok:true,updated:count,summary:summary(user.id,ws.id)});return true;
    }
    if(path==='/api/notifications/read-target'&&req.method==='POST'){
      const type=short(input.targetType,20),id=short(input.targetId,100);
      if(!['channel','thread','dm'].includes(type))throw fail(400,'Unknown conversation');
      const count=markTarget(user.id,ws.id,type,id);asJSON(res,200,{ok:true,updated:count});return true;
    }
    const match=path.match(/^\/api\/notifications\/([\w-]+)$/);
    if(match&&['PATCH','DELETE'].includes(req.method)){
      const row=get('SELECT * FROM notifications WHERE id=? AND user_id=? AND workspace_id=?',match[1],user.id,ws.id);
      if(!visible(user.id,row))throw fail(404,'Notification not found');
      if(req.method==='DELETE')run('UPDATE notifications SET dismissed_at=? WHERE id=?',now(),row.id);
      else {if(typeof input.read!=='boolean')throw fail(400,'read must be a boolean');run('UPDATE notifications SET read_at=? WHERE id=?',input.read?now():null,row.id)}
      publish(user.id,ws.id,req.method==='DELETE'?'dismissed':'read',row.id);
      asJSON(res,200,{ok:true,summary:summary(user.id,ws.id)});return true;
    }
    throw fail(404,'Notification endpoint not found');
  }
  return {api,onMessage,onEditedMentions,onAgentEvent,onApproval,purgeMessage,purgeConversation,markTarget,summary,settings};
}
