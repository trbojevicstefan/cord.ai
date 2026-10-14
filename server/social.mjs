import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { uid, now } from './database.mjs';

// Conversation enhancements are deliberately separate from the OPAYA/agent runtime.
// The server, not the browser, validates mention identities, conversation scope,
// ownership and attachment access.
const bad=(status,message)=>Object.assign(new Error(message),{status});
const types=new Map([
  ['image/png','.png'],['image/jpeg','.jpg'],['image/gif','.gif'],['image/webp','.webp'],
  ['application/pdf','.pdf'],['text/plain','.txt'],['text/markdown','.md'],
  ['application/json','.json'],['text/csv','.csv']
]);
const MAX_UPLOAD=8*1024*1024;
const MAX_ATTACHMENTS=5;
const emojiOK=value=>typeof value==='string'&&value.length>0&&value.length<=20&&/[\p{Extended_Pictographic}]/u.test(value)&&!/[<>\r\n]/.test(value);
const stringifyShort=(value,max)=>String(value??'').trim().slice(0,max);
const mentionsOf=text=>Array.from(String(text).matchAll(/<@([a-zA-Z0-9_-]{1,100})>/g),m=>m[1]);
const channelsOf=text=>Array.from(String(text).matchAll(/<#([a-zA-Z0-9_-]{1,100})>/g),m=>m[1]);
const allowedType=type=>['channel','thread','dm'].includes(type);

export function createSocial({store,canReadTarget,targetWorkspace,requireWorkspace,requireAdmin,recordMessage,broadcast,audit,bodyJSON,asJSON,databasePath}) {
  const {db,get,all,run}=store;
  const folder=join(dirname(databasePath),'uploads');
  const lastTyping=new Map();
  mkdirSync(folder,{recursive:true,mode:0o700});
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(message_id,user_id,emoji)
    );
    CREATE TABLE IF NOT EXISTS message_pins (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      pinned_by TEXT NOT NULL REFERENCES users(id), pinned_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_mentions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(message_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS message_mentions_user ON message_mentions(user_id);
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments(message_id);
  `);

  const getMessage=(userId,id)=>{
    const message=get('SELECT * FROM messages WHERE id=?',id);
    if(!message||!canReadTarget(userId,message.target_type,message.target_id))throw bad(404,'Message not found');
    return message;
  };
  const isAdmin=(user,ws)=>!!get("SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=? AND role IN ('owner','admin')",user,ws);
  const validateMentions=(userId,workspaceId,content)=>{
    const humans=new Set(),agents=new Set(),channels=new Set();
    for(const id of mentionsOf(content)){
      if(get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',workspaceId,id))humans.add(id);
      else if(get('SELECT 1 FROM agents WHERE workspace_id=? AND id=?',workspaceId,id))agents.add(id);
      else throw bad(400,'Unknown or inaccessible mention');
    }
    for(const id of channelsOf(content)){
      if(!get('SELECT 1 FROM channels WHERE workspace_id=? AND id=?',workspaceId,id))throw bad(400,'Unknown or inaccessible channel mention');
      channels.add(id);
    }
    if(/(^|\s)@(everyone|here)\b/i.test(content)){
      if(!isAdmin(userId,workspaceId))throw bad(403,'Only workspace admins can notify everyone or here');
      const onlineOnly=/(^|\s)@here\b/i.test(content)&&!/(^|\s)@everyone\b/i.test(content);
      for(const member of all('SELECT u.id,u.status FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=?',workspaceId)){
        if(!onlineOnly||member.status==='online')humans.add(member.id);
      }
    }
    humans.delete(userId);
    return {humans:[...humans],agents:[...agents],channels:[...channels]};
  };
  const attachmentIds=(userId,workspaceId,type,id,ids)=>{
    if(ids==null)return [];
    if(!Array.isArray(ids)||ids.length>MAX_ATTACHMENTS||new Set(ids).size!==ids.length)throw bad(400,`Attach up to ${MAX_ATTACHMENTS} different files`);
    for(const attachmentId of ids){
      if(typeof attachmentId!=='string')throw bad(400,'Invalid attachment ID');
      const item=get('SELECT * FROM message_attachments WHERE id=?',attachmentId);
      if(!item||item.user_id!==userId||item.workspace_id!==workspaceId||item.target_type!==type||item.target_id!==id||item.message_id)throw bad(403,'Attachment is not available in this conversation');
    }
    return ids;
  };
  const prepareMessage=(userId,target,type,id,input)=>{
    const content=String(input.content??'').trim().slice(0,24000);
    const files=attachmentIds(userId,target.workspace_id,type,id,input.attachmentIds);
    if(!content&&!files.length)throw bad(400,'Message cannot be empty');
    let replyTo=null;
    if(input.replyToId){
      const original=getMessage(userId,stringifyShort(input.replyToId,100));
      if(original.target_type!==type||original.target_id!==id)throw bad(400,'Reply must reference a message in this conversation');
      replyTo=original.id;
    }
    const mentions=validateMentions(userId,target.workspace_id,content);
    return {content:content||'📎 Attachment',files,replyTo,mentions,metadata:replyTo?{reply_to:replyTo}:{}};
  };
  const attachMessage=(message,prepared)=>{
    for(const id of prepared.files)run('UPDATE message_attachments SET message_id=? WHERE id=? AND user_id=? AND message_id IS NULL',message.id,id,message.author_id);
    for(const id of prepared.mentions.humans)run('INSERT OR IGNORE INTO message_mentions(message_id,user_id) VALUES(?,?)',message.id,id);
  };
  const mentionRows=(message,userId,content)=>{
    run('DELETE FROM message_mentions WHERE message_id=?',message.id);
    for(const id of validateMentions(userId,message.workspace_id,content).humans)run('INSERT OR IGNORE INTO message_mentions(message_id,user_id) VALUES(?,?)',message.id,id);
  };
  const decorate=(messages,userId)=>{
    if(!messages?.length)return messages||[];
    const placeholders=messages.map(()=>'?').join(',');const ids=messages.map(m=>m.id);
    const reactions=all(`SELECT message_id,user_id,emoji FROM message_reactions WHERE message_id IN (${placeholders}) ORDER BY created_at`,...ids);
    const pins=all(`SELECT message_id,pinned_by,pinned_at FROM message_pins WHERE message_id IN (${placeholders})`,...ids);
    const files=all(`SELECT id,message_id,filename,mime,bytes FROM message_attachments WHERE message_id IN (${placeholders})`,...ids);
    const replies=messages.filter(m=>{try{return !!JSON.parse(m.metadata||'{}').reply_to}catch{return false}});
    const originals=new Map();
    for(const m of replies){const id=JSON.parse(m.metadata).reply_to;if(!originals.has(id)){
      const reference=get('SELECT id,target_type,target_id,author_id,author_type,content FROM messages WHERE id=?',id);
      originals.set(id,reference&&reference.target_type===m.target_type&&reference.target_id===m.target_id?reference:null);
    }}
    const reactionsBy=new Map(),pinsBy=new Map(pins.map(p=>[p.message_id,p]));
    for(const r of reactions){const group=reactionsBy.get(r.message_id)||new Map();const item=group.get(r.emoji)||{emoji:r.emoji,count:0,mine:false};item.count++;if(r.user_id===userId)item.mine=true;group.set(r.emoji,item);reactionsBy.set(r.message_id,group)}
    return messages.map(m=>{
      let meta;try{meta=JSON.parse(m.metadata||'{}')}catch{meta={}}
      return {...m,reactions:[...(reactionsBy.get(m.id)?.values()||[])],pinned:!!pinsBy.get(m.id),
        reply:meta.reply_to?originals.get(meta.reply_to)||{id:meta.reply_to,deleted:true}:null,
        attachments:files.filter(f=>f.message_id===m.id).map(f=>({...f,url:`/api/social/uploads/${encodeURIComponent(f.id)}`}))};
    });
  };
  const unreadSummary=(userId,workspaceId)=>{
    const rows=all(`SELECT m.target_type,m.target_id,m.author_type,m.author_id,m.created_at,
      CASE WHEN mm.user_id IS NULL THEN 0 ELSE 1 END AS mentioned,
      r.last_read_at
      FROM messages m LEFT JOIN reads r ON r.user_id=? AND r.target_type=m.target_type AND r.target_id=m.target_id
      LEFT JOIN message_mentions mm ON mm.user_id=? AND mm.message_id=m.id
      WHERE m.workspace_id=? AND (r.last_read_at IS NULL OR m.created_at>r.last_read_at)
      AND NOT (m.author_type='user' AND m.author_id=?)
      ORDER BY m.created_at DESC LIMIT 1000`,userId,userId,workspaceId,userId);
    const counts={};for(const m of rows){if(!canReadTarget(userId,m.target_type,m.target_id))continue;
      const key=`${m.target_type}:${m.target_id}`;const item=counts[key]||{total:0,mentions:0};item.total++;item.mentions+=m.mentioned;counts[key]=item;
    }return counts;
  };
  const cleanFiles=files=>{
    for(const row of files)try{unlinkSync(join(folder,row.id))}catch(error){if(error.code!=='ENOENT')console.error('Attachment cleanup:',error.message)}
  };
  const purgeMessage=id=>{
    const files=all('SELECT id FROM message_attachments WHERE message_id=?',id);cleanFiles(files);
    run('DELETE FROM message_attachments WHERE message_id=?',id);
  };
  const purgeConversation=(type,id)=>{
    const files=all('SELECT id FROM message_attachments WHERE target_type=? AND target_id=?',type,id);cleanFiles(files);
    run('DELETE FROM message_attachments WHERE target_type=? AND target_id=?',type,id);
  };
  const broadcastMessage=message=>broadcast(message.workspace_id,'change',{scope:message.target_type,id:message.target_id,messageId:message.id},message.target_type==='dm'?message.target_id:null);

  async function api(req,res,url,user){
    const path=url.pathname;
    if(path==='/api/social/typing'&&req.method==='POST'){
      const input=await bodyJSON(req),type=String(input.targetType||''),id=String(input.targetId||'');
      if(!allowedType(type))throw bad(400,'Unknown conversation');
      const target=targetWorkspace(user.id,type,id);const key=user.id+':'+type+':'+id;
      const last=lastTyping.get(key)||0;
      if(Date.now()-last>3000){lastTyping.set(key,Date.now());
        broadcast(target.workspace_id,'typing',{userId:user.id,name:user.display_name,targetType:type,targetId:id,at:Date.now()},type==='dm'?id:null);
        if(lastTyping.size>3000){for(const [item,time] of lastTyping)if(Date.now()-time>60000)lastTyping.delete(item)}
      }
      asJSON(res,200,{ok:true});return true;
    }
    if(path==='/api/social/reactions'&&req.method==='POST'){
      const input=await bodyJSON(req),message=getMessage(user.id,stringifyShort(input.messageId,100));
      const emoji=String(input.emoji??'').trim();if(!emojiOK(emoji))throw bad(400,'Choose a valid emoji');
      const existing=get('SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?',message.id,user.id,emoji);
      if(existing)run('DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?',message.id,user.id,emoji);
      else run('INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)',message.id,user.id,emoji,now());
      broadcastMessage(message);audit(user.id,message.workspace_id,'message.react',message.target_type,message.id,{emoji,on:!existing});
      asJSON(res,200,{ok:true,active:!existing});return true;
    }
    if(path==='/api/social/pins'&&req.method==='POST'){
      const input=await bodyJSON(req),message=getMessage(user.id,stringifyShort(input.messageId,100));
      const t=message.target_type==='thread'?get('SELECT author_id FROM threads WHERE id=?',message.target_id):null;
      if(!isAdmin(user.id,message.workspace_id)&&t?.author_id!==user.id&&message.target_type!=='dm')throw bad(403,'Only moderators can pin messages here');
      const currently=!!get('SELECT 1 FROM message_pins WHERE message_id=?',message.id),pin=input.pinned===undefined?!currently:input.pinned===true;
      if(pin)run('INSERT INTO message_pins(message_id,pinned_by,pinned_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned_by=excluded.pinned_by,pinned_at=excluded.pinned_at',message.id,user.id,now());
      else run('DELETE FROM message_pins WHERE message_id=?',message.id);
      audit(user.id,message.workspace_id,pin?'message.pin':'message.unpin',message.target_type,message.id);broadcastMessage(message);
      asJSON(res,200,{ok:true,pinned:pin});return true;
    }
    if(path==='/api/social/pins'&&req.method==='GET'){
      const type=url.searchParams.get('type'),id=url.searchParams.get('id');if(!allowedType(type))throw bad(400,'Unknown conversation type');
      targetWorkspace(user.id,type,id);
      const pinned=all(`SELECT m.* FROM messages m JOIN message_pins p ON p.message_id=m.id WHERE m.target_type=? AND m.target_id=? ORDER BY p.pinned_at DESC LIMIT 100`,type,id);
      asJSON(res,200,{ok:true,messages:decorate(pinned,user.id)});return true;
    }
    const edit=path.match(/^\/api\/messages\/([^/]+)$/);
    if(edit&&req.method==='PATCH'){
      const message=getMessage(user.id,edit[1]);if(message.author_type!=='user'||message.author_id!==user.id)throw bad(403,'Only the author can edit a message');
      if(Date.now()-Date.parse(message.created_at)>14*24*3600*1000)throw bad(403,'Message editing is available for the first 14 days');
      const input=await bodyJSON(req),content=stringifyShort(input.content,24000);
      if(!content)throw bad(400,'Edited message cannot be empty');
      if(message.target_type==='thread'){
        const thread=get('SELECT archived,locked FROM threads WHERE id=?',message.target_id);
        if(thread?.archived)throw bad(403,'Thread is closed');
      }
      // Parse and validate mentions before persisting either edit or notification changes.
      const parsed=validateMentions(user.id,message.workspace_id,content);
      run('UPDATE messages SET content=?,edited_at=? WHERE id=?',content,now(),message.id);
      run('DELETE FROM message_mentions WHERE message_id=?',message.id);
      for(const id of parsed.humans)run('INSERT OR IGNORE INTO message_mentions(message_id,user_id) VALUES(?,?)',message.id,id);
      audit(user.id,message.workspace_id,'message.edit',message.target_type,message.id);broadcastMessage(message);
      asJSON(res,200,{ok:true,messageId:message.id});return true;
    }
    if(path==='/api/social/unreads'&&req.method==='GET'){
      const ws=requireWorkspace(user.id,url.searchParams.get('workspaceId'));
      asJSON(res,200,{ok:true,unreads:unreadSummary(user.id,ws.id)});return true;
    }
    if(path==='/api/social/uploads'&&req.method==='POST'){
      const type=url.searchParams.get('type'),id=url.searchParams.get('id');if(!allowedType(type))throw bad(400,'Unknown conversation type');
      const target=targetWorkspace(user.id,type,id);
      const mime=String(req.headers['content-type']||'').split(';')[0].toLowerCase().trim();
      if(!types.has(mime))throw bad(415,'Unsupported file type');
      let filename='file'+types.get(mime);
      try{filename=decodeURIComponent(String(req.headers['x-file-name']||filename)).replace(/[\\/\x00-\x1f]/g,'').trim().slice(0,100)||filename}catch{throw bad(400,'Invalid file name')}
      if(Number(req.headers['content-length']||'0')>MAX_UPLOAD)throw bad(413,'File exceeds 8 MB');
      const chunks=[];let length=0;
      for await(const piece of req){length+=piece.length;if(length>MAX_UPLOAD)throw bad(413,'File exceeds 8 MB');chunks.push(piece)}
      if(!length)throw bad(400,'Empty file');const buffer=Buffer.concat(chunks);
      // Reject obvious executable/HTML payloads masquerading as text and malformed image headers.
      if(mime==='image/png'&&!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw bad(415,'Invalid PNG');
      if(mime==='image/jpeg'&&!(buffer[0]===255&&buffer[1]===216))throw bad(415,'Invalid JPEG');
      if(mime==='image/gif'&&!['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii')))throw bad(415,'Invalid GIF');
      if(mime==='image/webp'&&!(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'))throw bad(415,'Invalid WebP');
      if(mime==='application/pdf'&&buffer.subarray(0,5).toString()!=='%PDF-')throw bad(415,'Invalid PDF');
      if(mime.startsWith('text/')||mime==='application/json'){
        const preview=buffer.subarray(0,200).toString('utf8').trimStart();
        if(/^<(?:!doctype\s+html|html|script|svg)\b/i.test(preview))throw bad(415,'Executable HTML files are not allowed');
      }
      const fileId=uid();writeFileSync(join(folder,fileId),buffer,{mode:0o600,flag:'wx'});
      run('INSERT INTO message_attachments(id,workspace_id,user_id,target_type,target_id,filename,mime,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)',fileId,target.workspace_id,user.id,type,id,filename,mime,length,now());
      asJSON(res,201,{ok:true,file:{id:fileId,filename,mime,bytes:length,url:`/api/social/uploads/${fileId}`}});return true;
    }
    const fileUrl=path.match(/^\/api\/social\/uploads\/([\w-]+)$/);
    if(fileUrl&&req.method==='DELETE'){
      const file=get('SELECT * FROM message_attachments WHERE id=?',fileUrl[1]);
      if(!file||file.user_id!==user.id||file.message_id)throw bad(404,'Staged attachment not found');
      cleanFiles([{id:file.id}]);run('DELETE FROM message_attachments WHERE id=?',file.id);
      asJSON(res,200,{ok:true});return true;
    }
    if(fileUrl&&['GET','HEAD'].includes(req.method)){
      const file=get('SELECT * FROM message_attachments WHERE id=?',fileUrl[1]);
      if(!file||!(file.message_id?canReadTarget(user.id,file.target_type,file.target_id):file.user_id===user.id))throw bad(404,'Attachment not found');
      const disk=join(folder,file.id);if(!existsSync(disk))throw bad(404,'Attachment missing from storage');
      const content=readFileSync(disk);
      const inline=file.mime.startsWith('image/');
      res.writeHead(200,{'content-type':file.mime,'content-length':content.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`});
      res.end(req.method==='HEAD'?undefined:content);return true;
    }
    return false;
  }
  return {api,prepareMessage,attachMessage,decorate,unreadSummary,purgeMessage,purgeConversation,validateMentions};
}
