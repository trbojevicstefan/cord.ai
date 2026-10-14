import { icon } from './icons.js';
import { createConnectionViews } from './connections.js';

const app=document.querySelector('#app');
const state={data:null,selected:{type:'channel',id:'channel-chat'},messages:[],dmView:false,screen:'chat',modal:null,menu:null,profile:null,selectedSettings:'account',searchOpen:false,searchResults:[],searchQuery:'',sidebarOpen:true,memberPanel:true,collapsed:new Set(),hideMuted:false,showArchived:false,threadShow:'all',drafts:{},typing:{},lastSelection:'',toast:null,busy:false,returnScreen:'chat'};
const get=(k,def=null)=>{try{const v=localStorage.getItem('cord:'+k);return v===null?def:JSON.parse(v)}catch{return def}};
const put=(k,v)=>{try{localStorage.setItem('cord:'+k,JSON.stringify(v))}catch{}};
state.collapsed=new Set(get('collapsed',[]));state.hideMuted=get('hideMuted',false);state.memberPanel=get('memberPanel',true);state.selected=get('selected',state.selected);state.dmView=get('dmView',false);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=esc;
const data=()=>state.data||{};
const A=()=>data().agents||[];
const connections=createConnectionViews({esc,icon,A,admin:()=>admin(),avatar:(...args)=>avatar(...args)});
const U=()=>data().members||[];
const C=()=>data().channels||[];
const T=()=>data().threads||[];
const K=()=>data().categories||[];
const D=()=>data().dms||[];
const me=()=>data().user||{};
const agent=id=>A().find(x=>x.id===id);
const member=id=>U().find(x=>x.id===id);
const channel=id=>C().find(x=>x.id===id);
const thread=id=>T().find(x=>x.id===id);
const category=id=>K().find(x=>x.id===id);
const dm=id=>D().find(x=>x.id===id);
const prefs=(type,id)=>data().preferences?.find(x=>x.target_type===type&&x.target_id===id)||{muted:0,favorite:0,notification_level:'all'};
const admin=()=>['owner','admin'].includes(member(me().id)?.role);
const avatar=(item,size=32,kind='human')=>`<span class="avatar ${kind==='agent'?'avatar-agent':''}" style="--avatar-color:${esc(item?.color||'#5865f2')};width:${size}px;height:${size}px;min-width:${size}px;font-size:${Math.round(size*.34)}px" title="${esc(item?.display_name||item?.name||'User')}">${esc(item?.avatar||item?.display_name?.split(' ').map(s=>s[0]).join('').slice(0,2)||item?.name?.slice(0,2)||'?')}<i class="presence ${esc(item?.status||'online')}"></i></span>`;
const userName=(type,id)=>type==='agent'?agent(id)?.name:type==='system'?'Cord AI':member(id)?.display_name||'Unknown';
const getAuthor=(type,id)=>type==='agent'?agent(id):type==='system'?{avatar:'C',color:'#5865f2',name:'Cord AI',status:'online'}:member(id);
const current=()=>state.selected.type==='thread'?thread(state.selected.id):state.selected.type==='channel'?channel(state.selected.id):dm(state.selected.id);
const targetTitle=()=>state.selected.type==='thread'?thread(state.selected.id)?.name:state.selected.type==='channel'?channel(state.selected.id)?.name:dmPartner(dm(state.selected.id))?.name;
const dmPartner=d=>d?.participant_agent_id?{...agent(d.participant_agent_id),kind:'agent',name:agent(d.participant_agent_id)?.name}:d?.participant_user_id?{...member(d.participant_user_id),kind:'human',name:member(d.participant_user_id)?.display_name}:null;
const readStatus=(type,id)=>data().reads?.find(x=>x.target_type===type&&x.target_id===id);
const iconButton=(name,action,title,extras='')=>`<button class="icon-btn" type="button" title="${esc(title)}" aria-label="${esc(title)}" data-action="${action}" ${extras}>${icon(name,19)}</button>`;
const dateTime=(iso)=>{if(!iso)return '';let date=new Date(iso);return date.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})};
const prettyDate=(iso)=>{try{return new Date(iso).toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'})}catch{return ''}};
async function api(path,opts={}){
  const res=await fetch('/api'+path,{credentials:'same-origin',headers:{'content-type':'application/json',...(opts.headers||{})},...opts,body:opts.body&&typeof opts.body!=='string'?JSON.stringify(opts.body):opts.body});
  let result={};try{result=await res.json()}catch{}
  if(!res.ok)throw new Error(result.error||`HTTP ${res.status}`);return result;
}
function toast(message,kind='info'){state.toast={message,kind};renderOverlays();clearTimeout(toast._timer);toast._timer=setTimeout(()=>{state.toast=null;renderOverlays()},4200)}
function handleError(error){console.error(error);toast(error?.message||'Something went wrong','error')}
async function loadData({messages=true,keepScroll=false}={}){
  const previousMessages=new Set(state.messages.map(m=>m.id));
  const result=await api('/bootstrap'+(state.workspaceId?'?workspaceId='+encodeURIComponent(state.workspaceId):''));state.data=result;applySettings();
  if(!current()){
    const fallback=state.dmView?D()[0]:C()[0];state.selected=fallback?{type:state.dmView?'dm':'channel',id:fallback.id}:{type:'channel',id:''};
  }
  if(messages&&current()){await loadMessages();if(keepScroll&&previousMessages.size&&document.hidden){const incoming=state.messages.filter(m=>!previousMessages.has(m.id)&&m.author_id!==me().id&&m.author_type!=='system');const pref=prefs(state.selected.type,state.selected.id);if(incoming.length&&!pref.muted&&pref.notification_level!=='none'&&(pref.notification_level!=='mentions'||incoming.some(m=>m.content.toLowerCase().includes('@'+me().username.toLowerCase())))){const last=incoming.at(-1);if(result.settings.desktopNotifications&&'Notification' in window&&Notification.permission==='granted')new Notification(userName(last.author_type,last.author_id),{body:last.content.slice(0,160),tag:state.selected.id});if(result.settings.notificationSound){try{const Audio=window.AudioContext||window.webkitAudioContext;const audio=new Audio(),tone=audio.createOscillator(),gain=audio.createGain();tone.connect(gain);gain.connect(audio.destination);gain.gain.value=.035;tone.frequency.value=660;tone.start();tone.stop(audio.currentTime+.12);tone.onended=()=>audio.close();}catch{}}}}}
  render({keepScroll});
}
async function loadMessages(){
  if(!current()){state.messages=[];return}
  const {type,id}=state.selected;const r=await api(`/messages?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);state.messages=r.messages;
}
function selectTarget(type,id){
  if(type==='dm'){state.dmView=true;put('dmView',true)}else{state.dmView=false;put('dmView',false)}
  state.selected={type,id};state.screen='chat';state.menu=null;state.profile=null;state.modal=null;state.lastSelection='';put('selected',state.selected);
  loadMessages().then(()=>{render(); markRead(type,id)}).catch(handleError);
}
async function markRead(type,id){try{await api('/read',{method:'POST',body:{targetType:type,targetId:id}})}catch{}}
function initEvents(){
  let stream;const connect=()=>{if(!state.data?.workspace)return;stream?.close();stream=new EventSource('/api/events?workspaceId='+encodeURIComponent(state.data.workspace.id));
    let timer; stream.addEventListener('change',()=>{clearTimeout(timer);timer=setTimeout(()=>loadData({keepScroll:true}).catch(handleError),150)});
    stream.addEventListener('agent',ev=>{try{const a=JSON.parse(ev.data),k=a.targetType+':'+a.targetId;state.typing[k]=['queued','running'].includes(a.status)?a.agentId:null;if(a.status==='failed')toast(`Agent run failed: ${a.error||'Unknown error'}`,'error');renderMessagesOnly()}catch{}});
    stream.addEventListener('progress',ev=>{try{const p=JSON.parse(ev.data),r=data().runs?.find(r=>r.id===p.runId);if(r)r.progress=p.progress;if(state.modal?.kind==='runs')renderOverlays();else if(state.screen==='settings'&&state.selectedSettings==='runs')render();}catch{}});
    stream.onerror=()=>{};
  };connect();return connect;
}
function parseMarkdown(text){
  // Treat agent and user content as text. Never accept arbitrary HTML from messages.
  const lines=esc(text).replace(/\r/g,'').split('\n');let list=false,code=false;let out='';
  const inline=line=>line.replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/(^|\s)(@(?:RWE Design|OPAYA Runner|Research Agent|[\w.-]+))/g,'$1<span class="mention">$2</span>');
  for(const line of lines){
    if(line.startsWith('```')){if(list){out+='</ul>';list=false}out+=code?'</code></pre>':'<pre><code>';code=!code;continue}
    if(code){out+=line+'\n';continue}
    if(/^\s*[•*-]\s+/.test(line)){if(!list){out+='<ul>';list=true}out+='<li>'+inline(line.replace(/^\s*[•*-]\s+/,''))+'</li>';continue}
    if(list){out+='</ul>';list=false}
    if(/^#{1,3}\s/.test(line))out+=`<h4>${inline(line.replace(/^#{1,3}\s/,''))}</h4>`;
    else if(line.trim())out+='<p>'+inline(line)+'</p>';
    else out+='<div class="line-space"></div>';
  }
  if(list)out+='</ul>';if(code)out+='</code></pre>';return out;
}
function selectedHeader(){
  const item=current(),type=state.selected.type;if(!item)return '';
  const head=type==='thread'?
    `<div class="breadcrumb" data-action="open-target" data-type="channel" data-id="${item.channel_id}">${icon('hash',20)}<span>${esc(channel(item.channel_id)?.name)}</span></div><span class="crumb-sep">›</span><span class="head-thread">${icon('threads',20)}<strong>${esc(item.name)}</strong></span>`:
    type==='channel'?`${icon('hash',22)}<strong>${esc(item.name)}</strong><span class="header-description">${esc(item.description||'')}</span>`:
    `${avatar(dmPartner(item),24,dmPartner(item)?.kind)}<strong>${esc(dmPartner(item)?.name||'Direct Message')}</strong>`;
  const actions=type==='thread'?`${iconButton('bell-off','toggle-mute','Mute thread')} ${iconButton('pin','favorite','Add to Favorites')} ${iconButton('users','toggle-members','Show members')}`:
    type==='channel'?`${iconButton('threads','browse-threads','Browse threads')} ${iconButton('bell','toggle-mute','Mute channel')} ${iconButton('users','toggle-members','Show members')}`:
    `${iconButton('pin','favorite','Pin conversation')} ${iconButton('users','toggle-members','Show profile')}`;
  return `<header class="room-header"><button class="mobile-menu icon-btn" data-action="mobile-menu" aria-label="Show channels">${icon('menu',20)}</button><div class="room-crumb">${head}</div><div class="room-tools">${actions}<button class="icon-btn header-more" data-action="open-room-menu" title="More options">${icon('more',21)}</button><button class="search-top" data-action="search"><span>Search ${esc(data().workspace?.name||'Cord AI')}</span>${icon('search',17)}</button></div></header>`;
}
function serverRail(){
  return `<aside class="server-rail"><div class="rail-stack">
    <button class="rail-item rail-brand ${state.dmView?'active':''}" data-action="goto-dm" title="Direct messages"><span class="rail-glyph">${icon('message-square',23)}</span></button>
    <div class="rail-rule"></div>
    <button class="rail-item workspace-logo ${!state.dmView?'active':''}" data-action="goto-workspace" title="${esc(data().workspace?.name)}"><span>${esc(data().workspace?.icon||'C')}</span></button>
    <button class="rail-item rail-other" data-action="open-agent-directory" title="AI Agents">${icon('bot',23)}</button>
    <button class="rail-item rail-new" data-action="connect-agent" title="Connect agent">${icon('plus',24)}</button>
    <div class="rail-rule"></div>
    <button class="rail-item rail-explore" data-action="show-invite" title="Invite team">${icon('users',22)}</button>
  </div><div class="rail-bottom"><button class="rail-help" data-action="show-help" title="Help">${icon('info',21)}</button></div></aside>`;
}
function catLabel(cat){const collapsed=state.collapsed.has(cat.id);return `<div class="category-row" data-context="category" data-id="${cat.id}">
    <button class="category-title" data-action="toggle-category" data-id="${cat.id}">${icon('down',11,collapsed?'rotate-minus':'')}<span>${esc(cat.name)}</span></button>
    <button class="cat-add" data-action="create-channel" data-cat="${cat.id}" aria-label="Add channel" title="Add channel">${icon('plus',17)}</button></div>`}
function threadRows(id){
  return T().filter(t=>t.channel_id===id&&(state.showArchived||!t.archived))
    .filter(t=>!state.hideMuted||!prefs('thread',t.id).muted)
    .map(t=>{const active=state.selected.type==='thread'&&state.selected.id===t.id;return `<div class="thread-row ${active?'active':''} ${prefs('thread',t.id).muted?'muted':''}" data-context="thread" data-id="${t.id}">
      <span class="tree-stem"></span><button data-action="open-target" data-type="thread" data-id="${t.id}" class="thread-name" title="${esc(t.name)}"><span>${esc(t.name)}</span></button>
      <div class="row-extras">${t.locked?icon('lock',13):''}${prefs('thread',t.id).favorite?icon('star',13):''}</div></div>`}).join('');
}
function channelRow(c){const active=state.selected.type==='channel'&&state.selected.id===c.id;
  if(state.hideMuted&&prefs('channel',c.id).muted)return '';
  return `<div class="channel-group"><div class="channel-row ${active?'active':''} ${prefs('channel',c.id).muted?'muted':''}" data-context="channel" data-id="${c.id}">
    <button data-action="open-target" data-type="channel" data-id="${c.id}" class="channel-name">${icon('hash',20)}<span>${esc(c.name)}</span></button>
    <div class="row-extras"><button data-action="create-thread" data-channel="${c.id}" title="Create thread">${icon('plus',15)}</button><button data-action="channel-settings" data-id="${c.id}" title="Edit channel">${icon('settings',14)}</button></div></div><div class="thread-branch">${threadRows(c.id)}</div></div>`;
}
function userPanel(){return `<div class="user-footer">
  <button class="own-status" data-action="open-profile" data-kind="user" data-id="${me().id}">${avatar(me(),31)}<span class="footer-person"><b>${esc(me().display_name)}</b><small>${esc(me().status||'Online')}</small></span></button>
  <button data-action="toggle-mic" class="user-btn" title="Voice is not available in MVP">${icon('microphone',18)}</button>
  <button data-action="toggle-headphones" class="user-btn" title="Voice is not available in MVP">${icon('headphones',19)}</button>
  <button data-action="open-settings" class="user-btn" title="User Settings">${icon('settings',20)}</button>
  </div>`;}
function sidebar(){
  if(state.dmView)return `<aside class="channel-panel ${state.sidebarOpen?'':'mobile-hidden'}"><div class="workspace-top dm-top"><button class="dm-find" data-action="search">Find or start a conversation</button></div>
    <div class="sidebar-scroll" data-context="sidebar"><div class="side-menu"><button data-action="show-friends">${icon('friends',21)} <span>Friends</span></button><button data-action="open-agent-directory">${icon('bot',20)} <span>AI Agents</span></button><button data-action="goto-workspace">${icon('hash',20)} <span>Team Channels</span></button></div>
    <div class="sidebar-divider"></div><div class="dm-category"><span>DIRECT MESSAGES</span><button data-action="new-dm" title="New direct message">${icon('plus',15)}</button></div>
    ${D().map(d=>{const p=dmPartner(d);if(!p)return '';return `<button class="dm-entry ${state.selected.type==='dm'&&state.selected.id===d.id?'active':''}" data-action="open-target" data-type="dm" data-id="${d.id}">${avatar(p,30,p.kind)}<span>${esc(p.name)}</span>${p.kind==='agent'?'<b class="tiny-bot">APP</b>':''}</button>`}).join('')}
    </div>${userPanel()}</aside>`;
  return `<aside class="channel-panel ${state.sidebarOpen?'':'mobile-hidden'}">
    <div class="workspace-top"><button class="workspace-switcher" data-action="workspace-menu">${esc(data().workspace?.name||'Cord AI Team')} ${icon('down',14)}</button><button class="invite-people" data-action="show-invite" title="Invite people">${icon('friends',19)}</button></div>
    <div class="sidebar-scroll" data-context="sidebar">
      <div class="quick-links"><button data-action="open-agent-directory">${icon('bot',19)}<span>AI Agent Directory</span><small>${A().length}</small></button><button data-action="open-run-log">${icon('terminal',18)}<span>Agent Runs</span></button></div>
      <div class="sidebar-divider"></div>
      ${K().map(cat=>`${catLabel(cat)}${state.collapsed.has(cat.id)?'':`<div class="cat-channels">${C().filter(c=>c.category_id===cat.id).map(channelRow).join('')}</div>`}`).join('')}
      ${C().filter(c=>!c.category_id).map(channelRow).join('')}
      <button class="sidebar-quick-action" data-action="create-category">${icon('plus',15)} Add category</button>
      <div class="side-section-label">AGENT WORKSPACE <button data-action="connect-agent" title="Connect agent">${icon('plus',15)}</button></div>
      <button class="side-special" data-action="open-agent-directory">${icon('sparkles',18)} <span>Connected agents</span><strong>${A().length}</strong></button>
    </div>${userPanel()}</aside>`;
}
function rightPanel(){
  if(!state.memberPanel)return '';
  if(state.selected.type==='dm'){
    const p=dmPartner(current());if(!p)return '';
    return `<aside class="right-panel profile-panel"><div class="dm-cover" style="--cover:${esc(p.color||'#ec6659')}"><span>${icon('more',20)}</span></div><div class="dm-profile-avatar">${avatar(p,74,p.kind)}</div><div class="dm-info"><h3>${esc(p.name)}</h3><span class="dm-handle">${p.kind==='agent'?'Agent · Integrated via '+(p.type||'demo'):'Team member'} ${p.kind==='agent'?'<span class="badge-app">APP</span>':''}</span><div class="profile-separator"></div><strong>ABOUT ME</strong><p>${esc(p.description||(p.kind==='agent'?'An AI agent working with your team.':'A member of your team workspace.'))}</p><strong>CONNECTION</strong><p>${p.kind==='agent'?`Connector: ${esc(p.type||'demo')}`:'Cord team member'}</p><button class="outline-button full" data-action="open-profile" data-kind="${p.kind==='agent'?'agent':'user'}" data-id="${p.id}">View Full Profile</button></div></aside>`;
  }
  return `<aside class="right-panel members-panel"><div class="panel-group"><div class="panel-heading">TEAM — ${U().length}</div>${U().map(u=>memberRow(u,'user')).join('')}</div><div class="panel-group"><div class="panel-heading">AI AGENTS — ${A().length}</div>${A().map(a=>memberRow(a,'agent')).join('')}</div><div class="panel-small-callout"><span class="mini-symbol">✦</span><div><strong>Agents work with your team</strong><small>Invite any agent into a thread.</small></div></div></aside>`;
}
function memberRow(item,kind){return `<button class="member-row" data-action="open-profile" data-kind="${kind}" data-id="${item.id}">${avatar(item,32,kind)}<span class="member-row-name">${esc(item.display_name||item.name)}</span>${kind==='agent'?'<span class="badge-app">APP</span>':(item.role==='owner'?'<span class="crown">♛</span>':'')}</button>`}
function messageBubble(m,i){
  const item=getAuthor(m.author_type,m.author_id),name=userName(m.author_type,m.author_id),time=dateTime(m.created_at);
  const before=state.messages[i-1];const grouped=before&&before.author_id===m.author_id&&before.author_type===m.author_type&&Date.parse(m.created_at)-Date.parse(before.created_at)<5*60*1000&& !m.metadata?.includes('thread_ref');
  let meta;try{meta=JSON.parse(m.metadata||'{}')}catch{meta={}}
  const threadRef=meta.thread_ref?thread(meta.thread_ref):null;
  let inner=m.author_type==='system'?`<div class="system-thread-badge">${icon('threads',19)}</div><div class="message-body"><div class="system-text">${esc(name)} ${esc(m.content.split(':')[0])}: <b>${esc(threadRef?.name||'thread')}</b></div>${threadRef?threadPreview(threadRef):''}</div>`:
    `${grouped?'<div class="compact-avatar-time">'+esc(time)+'</div>':avatar(item,40,m.author_type==='agent'?'agent':'human')}<div class="message-body">
       ${grouped?'':`<div class="message-meta"><button data-action="open-profile" data-id="${m.author_id}" data-kind="${m.author_type==='agent'?'agent':'user'}" class="author-name">${esc(name)}</button>${m.author_type==='agent'?'<span class="badge-app">APP</span>':''}<span class="message-time">${esc(time)}</span></div>`}
       <div class="markdown">${parseMarkdown(m.content)}</div>${threadRef?threadPreview(threadRef):''}
     </div>`;
  return `<div class="message ${grouped?'grouped':''} ${m.author_type==='system'?'system-message':''}" data-message-id="${m.id}" ${state.selected.type==='channel'&&m.author_type!=='system'?`data-context="message" data-id="${m.id}"`:''}>${inner}${m.author_type!=='system'?`<div class="message-toolbar">${state.selected.type==='channel'?`<button data-action="thread-message" data-id="${m.id}" title="${threadRef?'Open thread':'Create thread'}" aria-label="${threadRef?'Open thread':'Create thread'}">${icon('threads',17)}</button>`:''}<button data-action="react-message" data-id="${m.id}" title="Add reaction">${icon('smile',17)}</button><button data-action="reply-message" data-id="${m.id}" title="Reply">${icon('message-square',17)}</button><button data-action="copy-message" data-id="${m.id}" title="Copy message">${icon('copy',17)}</button>${m.author_type==='user'&&m.author_id===me().id?`<button data-action="delete-message" data-id="${m.id}" title="Delete message">${icon('trash',17)}</button>`:''}</div>`:''}</div>`;
}
function threadPreview(t){
  const messages=t?state.messages.filter(m=>m.target_type==='thread'&&m.target_id===t.id):[];
  return `<button class="thread-preview" data-action="open-target" data-type="thread" data-id="${t.id}"><span class="thread-preview-title">${icon('threads',15)}<strong>${esc(t.name)}</strong><small>Open thread ${icon('chevron',12)}</small></span><span class="thread-preview-sub">${icon('bot',15)} ${esc(agent(t.agent_id)?.name||'Team discussion')} <span>·</span> Continue the conversation in its own thread</span></button>`;
}
function intro(){
  const {type,id}=state.selected;
  if(type==='thread'){
    const t=thread(id);if(!t)return '';
    return `<div class="conversation-intro"><div class="intro-mark thread-mark">${icon('threads',31)}</div><h1>${esc(t.name)}</h1><div class="thread-origin">Started by <b>${esc(member(t.author_id)?.display_name||'Team member')}</b> <span>in</span> <button data-action="open-target" data-type="channel" data-id="${t.channel_id}"># ${esc(channel(t.channel_id)?.name)}</button></div>${t.archived?'<div class="read-only-banner">'+icon('archive',15)+' Closed thread · Reopen from the context menu to reply</div>':''}${t.locked?'<div class="read-only-banner">'+icon('lock',15)+' Thread locked for members</div>':''}</div>`;
  }
  if(type==='channel'){
    const c=channel(id);return `<div class="conversation-intro channel-intro"><div class="intro-mark">${icon('hash',37)}</div><h1>Welcome to #${esc(c?.name||'channel')}!</h1><p>This is the beginning of the <b>#${esc(c?.name)}</b> channel.</p><button class="text-link" data-action="create-thread" data-channel="${id}">${icon('plus',14)} Create a focused thread</button></div>`;
  }
  const p=dmPartner(dm(id));return `<div class="conversation-intro channel-intro"><div class="intro-mark no-bg">${avatar(p,74,p?.kind)}</div><h1>${esc(p?.name||'Direct message')}</h1><p>This is the beginning of your direct message history with ${esc(p?.name||'this person')}.</p></div>`;
}
function messagesPanel(){
  if(!current())return `<div class="empty-center"><h2>Choose a channel</h2><p>Start a conversation with your team or agents.</p></div>`;
  const type=state.selected.type,id=state.selected.id,key=type+':'+id,t=thread(id),disable=type==='thread' && (t?.archived||(t?.locked&&!admin()&&t.author_id!==me().id));
  const typingAgent=agent(state.typing[key]);
  return `<div class="chat-scroll" id="chat-scroll"><div class="chat-content">${intro()}${state.messages.length?`<div class="date-divider"><span>${esc(prettyDate(state.messages[0].created_at))}</span></div>`:''}${state.messages.map(messageBubble).join('')}${typingAgent&&data().settings?.showTyping!==false?`<div class="typing-indicator"><span class="typing-dots"><i></i><i></i><i></i></span> ${esc(typingAgent.name)} is thinking…</div>`:''}</div></div>
  ${connections.approvals((data().approvals||[]).filter(p=>p.target_type===type&&p.target_id===id))}<div class="composer-holder">${disable?`<div class="composer-disabled">${icon('lock',18)} This thread is ${t.archived?'closed':'locked'} · Ask a moderator to reopen it</div>`:`<form class="composer" id="composer" data-form="message"><button class="composer-add" type="button" data-action="composer-add" title="Add attachment or create thread">${icon('plus',22)}</button><textarea aria-label="Message" id="message-input" placeholder="Message ${type==='thread'?esc(t?.name):type==='channel'?'#'+esc(channel(id)?.name):'@'+esc(targetTitle())}" rows="1">${esc(state.drafts[key]||'')}</textarea><div class="composer-tools"><button type="button" class="composer-tool" data-action="insert-emoji" title="Emoji">${icon('smile',20)}</button><button type="button" class="composer-tool" data-action="insert-mention" title="Mention agent">${icon('bot',20)}</button><button type="submit" class="composer-send" title="Send message">${icon('send',18)}</button></div></form>`}<div class="composer-hint">${type==='thread'?`${esc(agent(t?.agent_id)?.name||'No agent assigned')} · ${esc(t?.agent_mode||'mentions')} replies · `:''}<b>${data().settings?.enterToSend===false?'Ctrl+Enter':'Enter'}</b> to send · <b>Shift+Enter</b> for a new line</div></div>`;
}
function chatShell(){return `<div class="app-shell">
  <div class="window-bar"><div class="window-left">${icon('arrow',14)} ${icon('chevron',14)}</div><div class="window-center"><span class="window-brand">C</span><span>${esc(data().workspace?.name||'Cord AI')}</span></div><div class="window-right"><span class="secure-dot"></span> Team & Agents</div></div>
  <div class="app-main">${serverRail()}${sidebar()}<main class="chat-main">${selectedHeader()}<div class="conversation-area">${messagesPanel()}${rightPanel()}</div></main></div></div>`;
}

const option=(value,label,selected)=>`<option value="${attr(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`;
const opts=(values,selected)=>values.map(([value,label])=>option(value,label,selected)).join('');
function agentOptions(selected,includeNone=true){return `${includeNone?option('','No agent',selected):''}${A().map(a=>option(a.id,`${a.name} · ${a.type}`,selected)).join('')}`}
function channelOptions(selected){return C().map(c=>option(c.id,`# ${c.name}`,selected)).join('')}
function categoryOptions(selected,nullable=false){return `${nullable?option('','Uncategorized',selected):''}${K().map(c=>option(c.id,c.name,selected)).join('')}`}
const field=(label,html,hint='')=>`<label class="field"><span class="field-label">${esc(label)}</span>${html}${hint?`<small class="field-hint">${esc(hint)}</small>`:''}</label>`;
const input=(name,value='',extra='')=>`<input class="form-control" name="${name}" value="${attr(value)}" ${extra}/>`;
const select=(name,content)=>`<select class="form-control" name="${name}">${content}</select>`;
const switcher=(name,checked)=>`<label class="switch"><input type="checkbox" name="${name}" ${checked?'checked':''}/><span class="switch-track"></span></label>`;
function threadEditor(){
  const t=thread(state.selected.id);if(!t){state.screen='chat';return chatShell()}
  return `<div class="settings-layout thread-editor-layout"><aside class="settings-sidebar"><div class="settings-sidebar-content"><div class="settings-nav-title small truncate">${icon('threads',15)} ${esc(t.name)}</div><button class="settings-nav active" data-action="editor-tab" data-tab="overview">Overview</button><div class="settings-sep"></div><button class="settings-nav danger" data-action="delete-thread" data-id="${t.id}">Delete Thread ${icon('trash',16)}</button><div class="settings-sep"></div><button class="settings-nav ghost" data-action="exit-editor">${icon('arrow',16)} Back to conversation</button></div></aside>
  <main class="settings-main"><div class="settings-inner editor-inner"><button class="settings-exit" data-action="exit-editor" title="Close">${icon('close',24)}<small>ESC</small></button><h2>Overview</h2>
  <form data-form="edit-thread" class="editor-form">
    ${field('THREAD NAME',input('name',t.name,'required maxlength="120" autofocus'))}
    ${field('SLOWMODE',select('slowmode',opts([[0,'Off'],[5,'5 seconds'],[10,'10 seconds'],[15,'15 seconds'],[30,'30 seconds'],[60,'1 minute'],[300,'5 minutes'],[900,'15 minutes'],[3600,'1 hour']],t.slowmode)),'Members will be restricted to one message per interval, unless they have administrator permissions.')}
    ${field('HIDE AFTER INACTIVITY',select('autoHideDays',opts([[1,'1 Day'],[3,'3 Days'],[7,'1 Week'],[30,'1 Month']],t.auto_hide_days)),'Threads are hidden in the channel list after their inactivity period. Their history is preserved.')}
    <div class="editor-toggle-row"><div><strong>SPOILER THREAD</strong><p>Hide sensitive discussion content until a member chooses to view it.</p></div>${switcher('spoiler',t.spoiler)}</div>
    <div class="editor-group-title">AI AGENT ASSIGNMENT <span class="badge-beta">CORD AI</span></div>
    ${field('ASSIGNED AGENT',select('agentId',agentOptions(t.agent_id)),'An agent can participate in this thread with a dedicated, persistent conversation history.')}
    ${field('REPLY BEHAVIOR',select('agentMode',opts([['auto','Auto — reply to every human message'],['mentions','Mentions only — reply when addressed'],['off','Off — no automatic agent replies']],t.agent_mode)),'Agent-to-agent messages never trigger more automatic replies. Only human messages can initiate a run.')}
    <div class="editor-toggle-row"><div><strong>CLOSE THREAD</strong><p>Archive the thread and prevent additional messages until reopened.</p></div>${switcher('archived',t.archived)}</div>
    <div class="editor-toggle-row"><div><strong>LOCK THREAD</strong><p>Only the creator and workspace administrators may post.</p></div>${switcher('locked',t.locked)}</div>
    <div class="editor-save"><button class="button-secondary" type="button" data-action="exit-editor">Cancel</button><button class="button-primary" type="submit">Save Changes</button></div>
  </form></div></main></div>`;
}
const settingSections=[
  {title:'USER SETTINGS',items:[['account','Account','user'],['privacy','Data & Privacy','shield'],['notifications','Notifications','bell']]},
  {title:'EXPERIENCE',items:[['appearance','Appearance','eye'],['messaging','Messaging','message-circle'],['shortcuts','Keyboard Shortcuts','terminal']]},
  {title:'TEAM & AI',items:[['agents','Connected Agents','bot'],['runs','Agent Runs','terminal'],['security','Security & Access','shield-check']]}
];
function settingsView(){
  return `<div class="settings-layout"><aside class="settings-sidebar"><div class="settings-sidebar-content"><div class="settings-identity">${avatar(me(),36)}<span><b>${esc(me().display_name)}</b><small>${esc(me().username)}</small></span></div><button class="settings-search" data-action="settings-search">${icon('search',18)} Search settings</button>
  ${settingSections.map(g=>`<div class="settings-nav-title">${g.title}</div>${g.items.map(([key,label,ico])=>`<button class="settings-nav ${state.selectedSettings===key?'active':''}" data-action="settings-section" data-section="${key}">${icon(ico,18)}<span>${label}</span></button>`).join('')}<div class="settings-sep"></div>`).join('')}
  <button class="settings-nav danger" data-action="logout">${icon('log-out',18)} Log out</button><div class="settings-footer">CORD AI · 0.2<br/>Your team. Your agents.</div></div></aside>
  <main class="settings-main"><div class="settings-inner"><button class="settings-exit" data-action="exit-settings" title="Close">${icon('close',23)}<small>ESC</small></button>${settingsContent()}</div></main></div>`;
}
function applySettings(){
 const s=data().settings||{};document.documentElement.dataset.theme=s.theme||'dark';document.documentElement.dataset.density=s.density||'comfortable';document.documentElement.style.setProperty('--message-font-size',(s.fontSize||13)+'px');
}
function preferenceSettings(section){
 const s=data().settings||{};
 const check=(key,label,hint)=>`<div class="settings-info-row"><span><strong>${label}</strong><small class="field-hint">${hint}</small></span>${switcher(key,s[key])}</div>`;
 if(['appearance','messaging','notifications'].includes(section))return `<div class="settings-page-title">${section[0].toUpperCase()+section.slice(1)}</div><form data-form="preferences" class="settings-section"><h2>Display</h2>${field('THEME',select('theme',opts([['dark','Midnight'],['light','Daylight']],s.theme)))}${field('MESSAGE DENSITY',select('density',opts([['comfortable','Comfortable'],['compact','Compact']],s.density)))}${field('MESSAGE FONT SIZE',select('fontSize',opts([12,13,14,16,18].map(n=>[n,n+' px']),s.fontSize)))}<h2>Messaging</h2>${check('enterToSend','Enter to send','When off, use Ctrl/⌘+Enter to send. Shift+Enter always inserts a line break.')}${check('showTyping','Show agent activity','Show when an agent is queued or working in your conversation.')}<h2>Notifications</h2>${check('desktopNotifications','Desktop notifications','Notify about new messages in the open conversation while Cord is in the background.')}${check('notificationSound','Message sound','Play a short sound for background conversation activity.')}<div class="connection-actions"><button type="button" class="button-secondary" data-action="enable-notifications">Allow Desktop Notifications</button><button type="submit" class="button-primary">Save Preferences</button></div><p class="muted-paragraph">Per-channel mute and notification levels are available in each conversation’s right-click menu. Preferences sync with your account.</p></form>`;
 if(section==='account')return `<div class="settings-page-title">Account</div><div class="settings-section"><h2>Your Profile</h2><div class="settings-info-row"><strong>${esc(me().display_name)}</strong><span>@${esc(me().username)}</span><button class="button-secondary" data-action="edit-profile">Edit Profile</button></div><div class="connection-actions"><button class="button-secondary" data-action="change-password">Change Password</button><button class="button-secondary" data-action="show-sessions">Manage Sessions</button></div></div>${admin()?`<form class="settings-section" data-form="workspace"><h2>Workspace</h2>${field('WORKSPACE NAME',input('name',data().workspace.name,'required minlength="2" maxlength="80"'))}${field('ICON',input('icon',data().workspace.icon||'C','maxlength="3"'))}<button class="button-primary" type="submit">Save Workspace</button></form>`:''}`;
 if(section==='privacy')return `<div class="settings-page-title">Data & Privacy</div><div class="settings-section"><h2>Your Data</h2><p class="muted-paragraph">Messages and preferences are stored on this Cord server. A paired agent only receives the recent history of conversations it is asked to answer. Runtime logins stay on the agent’s computer. Pairing codes expire after 15 minutes; bridge access can be revoked at any time.</p><button class="button-secondary" data-action="export-data">Export My Accessible Data</button></div><div class="settings-section"><h2>Local Data</h2><p class="muted-paragraph">Reset saved drafts, sidebar state, and navigation on this browser. Account preferences and team conversations are preserved.</p><button class="button-secondary" data-action="clear-local">Reset Browser Preferences</button></div>`;
 if(section==='shortcuts')return `<div class="settings-page-title">Keyboard Shortcuts</div><div class="settings-section">${[['Ctrl / ⌘ + K','Search'],['Ctrl / ⌘ + ,','Open settings'],['Escape','Close a menu or dialog / return to chat'],['Enter','Send a message (when enabled)'],['Ctrl / ⌘ + Enter','Send a message'],['Shift + Enter','New line'],['Right-click','Conversation and message actions']].map(([key,label])=>`<div class="settings-info-row"><strong>${label}</strong><kbd>${key}</kbd></div>`).join('')}</div>`;
 return '';
}
function securitySettings(){return `<div class="settings-page-title">Security & Access</div><div class="settings-section"><h2>Agent Permissions</h2><p class="muted-paragraph">Only workspace admins can pair, configure, or disconnect agents. Agent messages never trigger other agents. Codex and Hermes ACP tool requests appear here for approval; Claude Code uses its configured native permissions. A bridge can only claim jobs for its paired identity.</p>${connections.approvals(data().approvals||[])}<button class="button-secondary" data-action="show-sessions">Manage My Sessions</button></div><div class="settings-section"><h2>Connected Devices</h2>${connections.cards()}</div>`;}
function settingsContent(){const page=preferenceSettings(state.selectedSettings);if(page)return page;switch(state.selectedSettings){
 case 'agents':return `<div class="settings-page-title">Connected Agents</div><div class="settings-section"><p class="muted-paragraph">Your local agents, connected to the team with one prompt.</p>${connections.cards()}${admin()?'<button class="button-primary" data-action="connect-agent">Connect Agent</button>':''}</div>`;
 case 'runs':return `<div class="settings-page-title">Agent Runs & Approvals</div>${connections.approvals(data().approvals||[])}${connections.runs(data().runs||[])}`;
 case 'security':return securitySettings();
 default:return preferenceSettings('account');
}}
function modalFrame(title,content,{description='',wide=false,footer=''}={}){return `<div class="modal-scrim" data-action="dismiss-modal"><div class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-stop-click="true"><div class="modal-head"><div><h2>${esc(title)}</h2>${description?`<p>${esc(description)}</p>`:''}</div><button type="button" class="modal-x" data-action="dismiss-modal">${icon('close',20)}</button></div>${content}${footer}</div></div>`}
function modalBody(){const modal=state.modal;if(!modal)return '';
 switch(modal.kind){
 case 'create-channel':return modalFrame('Create Channel',`<form data-form="create-channel" class="modal-form">${field('CHANNEL NAME',input('name','',`required placeholder="new-channel" maxlength="60" autofocus`))}${field('CATEGORY',select('categoryId',categoryOptions(modal.categoryId||K()[0]?.id,true)))}${field('DESCRIPTION',input('description','',`placeholder="What is this channel for?"`))}<div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">Create Channel</button></div></form>`,{description:'Channels organize your team and its AI agents.'});
 case 'create-category':return modalFrame('Create Category',`<form data-form="create-category" class="modal-form">${field('CATEGORY NAME',input('name','',`required maxlength="70" placeholder="PROJECTS" autofocus`))}<div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">Create Category</button></div></form>`);
 case 'create-thread':return modalFrame('Create Thread',`<form data-form="create-thread" class="modal-form">${field('CHANNEL',select('channelId',channelOptions(modal.channelId||channel(state.selected.id)?.id||C()[0]?.id)).replace('<select ',`<select ${modal.sourceMessageId?'disabled':''} `))}${modal.sourceMessageId?`<div class="info-banner">Starting from ${esc(userName(modal.sourceAuthorType,modal.sourceAuthorId))}: ${esc(modal.sourceContent.slice(0,240))}</div>`:''}${field('THREAD NAME',input('name',modal.name||'',`required maxlength="120" placeholder="What are we working on?" autofocus`))}${field('FIRST MESSAGE',`<textarea class="form-control" name="firstMessage" rows="3" placeholder="Start a focused conversation…"></textarea>`)}<div class="modal-divider"></div>${field('ASSIGN AGENT (OPTIONAL)',select('agentId',agentOptions('')))}${field('AGENT REPLY BEHAVIOR',select('agentMode',opts([['auto','Auto — reply to human messages'],['mentions','Mentions only'],['off','Off']], 'mentions')))}<div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">Create Thread</button></div></form>`,{description:'Focused conversations stay nested underneath their channel.'});
 case 'edit-channel':{const c=channel(modal.id);if(!c)return '';return modalFrame('Edit Channel',`<form data-form="edit-channel" class="modal-form">${field('CHANNEL NAME',input('name',c.name,'required maxlength="60" autofocus'))}${field('DESCRIPTION',input('description',c.description||''))}${field('CATEGORY',select('categoryId',categoryOptions(c.category_id,true)))}<div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">Save Changes</button></div></form>`)}
 case 'edit-category':{const c=category(modal.id);if(!c)return '';return modalFrame('Edit Category',`<form data-form="edit-category" class="modal-form">${field('CATEGORY NAME',input('name',c.name,'required maxlength="70" autofocus'))}<div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">Save Changes</button></div></form>`)}
 case 'invite':return modalFrame('Invite your team',`<div class="modal-form"><div class="invite-graphic">${icon('users',37)}<span>People and agents. One workspace.</span></div><p class="muted-paragraph">Generate a single-use invite code, valid for seven days. Share it privately with a teammate. They can sign up using the invite link.</p><button class="button-primary full" data-action="generate-invite">Generate Invite Link</button>${modal.link?`<div class="invite-copy"><input class="form-control" readonly value="${attr(modal.link)}"/><button data-action="copy-invite">${icon('copy',17)}</button></div>`:''}</div>`);
 case 'notifications':{const p=prefs(modal.targetType,modal.id);return modalFrame('Notification Settings',`<div class="modal-form"><p class="muted-paragraph">Choose how often you receive notifications for this ${esc(modal.targetType)}.</p>${[['all','All Messages','Get notified when anyone sends a message'],['mentions','Only @mentions','Only when someone explicitly tags you'],['none','Nothing','Mute this conversation']].map(([v,label,description])=>`<button class="notification-option ${p.notification_level===v?'selected':''}" data-action="set-notif" data-id="${modal.id}" data-target="${modal.targetType}" data-level="${v}"><span class="radio-indicator"></span><span><b>${label}</b><small>${description}</small></span></button>`).join('')}</div>`)}
 case 'delete-confirm':return modalFrame('Delete '+(modal.targetType==='thread'?'Thread':modal.targetType==='category'?'Category':modal.targetType==='agent'?'Agent':'Channel'),`<div class="modal-form"><div class="danger-callout">${icon('info',19)} This will permanently delete the selected ${esc(modal.targetType)}. This action cannot be undone.</div><div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="button" class="button-danger" data-action="confirm-delete">Delete</button></div></div>`);
 case 'new-dm':return modalFrame('New Direct Message',`<div class="modal-form"><div class="modal-search-field">${icon('search',18)} Search for a teammate or agent</div>${[...U().filter(u=>u.id!==me().id).map(u=>({...u,kind:'user',name:u.display_name})),...A().map(a=>({...a,kind:'agent'}))].map(person=>`<button class="person-select" data-action="create-dm" data-kind="${person.kind}" data-id="${person.id}">${avatar(person,33,person.kind)}<span>${esc(person.name||person.display_name)}</span>${person.kind==='agent'?'<b class="badge-app">APP</b>':''}</button>`).join('')}</div>`);
 case 'agent-directory':return modalFrame('AI Agent Directory',`<div class="modal-form agent-directory"><p class="muted-paragraph">Claude Code, Codex, Hermes, OpenClaw and OPAYA — your agents, working with your team.</p>${connections.cards()}${admin()?'<button class="button-primary full" data-action="connect-agent">Connect an Agent</button>':''}</div>`,{wide:true});
 case 'easy-connect':return modalFrame('Connect an Agent',connections.wizard(modal),{description:'One prompt. Your agent joins the team.',wide:true});
 case 'connection-settings':{const a=agent(modal.id);return a?modalFrame(a.name,connections.settings(a),{wide:true}):'';}
 case 'advanced-agent':case 'edit-agent':{
  const a=modal.id?agent(modal.id):null;return modalFrame(a?'Edit Agent Connector':'Connect an AI Agent',`<form data-form="${a?'edit-agent':'connect-agent'}" class="modal-form">
   ${field('AGENT NAME',input('name',a?.name||'',`required maxlength="65" placeholder="e.g. RWE Design" autofocus`))}
   ${field('DESCRIPTION',input('description',a?.description||'',`placeholder="What does this agent do?"`))}
   ${field('CONNECTOR TYPE',select('type',opts([['demo','Demo (no model — preview only)'],['openai','OpenAI-compatible API'],['opaya','OPAYA bridge'],['webhook','Custom webhook']],a?.type||'demo')))}
   <div class="connector-help">${icon('info',16)} <span>For local runtimes, use Connect Agent and copy the generated prompt. This advanced form is for existing HTTP APIs and signed webhooks.</span></div>
   ${field('ENDPOINT URL',input('endpoint',a?.endpoint||'',`placeholder="https://your-agent.example/api/v1"`),'For OpenAI-compatible connectors: the base URL before /chat/completions. For OPAYA/webhook: the exact bridge POST URL.')}
   ${field('MODEL (OPENAI COMPATIBLE)',input('model',a?.model||'',`placeholder="gpt-4.1-mini"`))}
   ${field('EXTERNAL AGENT ID (OPAYA)',input('externalId',a?.external_id||'',`placeholder="agent-id-in-opaya"`))}
   ${field('API KEY / BRIDGE SHARED SECRET',`<input class="form-control" name="secret" type="password" placeholder="${a?'Leave blank to keep existing secret':'Stored encrypted with CORD_MASTER_KEY'}" autocomplete="new-password" />`)}
   <div class="modal-footer"><button type="button" class="button-secondary" data-action="dismiss-modal">Cancel</button><button type="submit" class="button-primary">${a?'Save Agent':'Connect Agent'}</button></div></form>`,{description:'Make your agents part of the team.',wide:true})}
 case 'runs':return modalFrame('Agent Runs & Approvals',`<div class="modal-form">${connections.approvals(data().approvals||[])}${connections.runs(data().runs||[])}</div>`,{wide:true});
 case 'threads-browser':return modalFrame('Browse Threads',`<div class="modal-form"><div class="filter-row"><button class="pill ${state.showArchived?'':'selected'}" data-action="filter-threads" data-mode="active">Active</button><button class="pill ${state.showArchived?'selected':''}" data-action="filter-threads" data-mode="all">All threads</button></div>${T().filter(t=>t.channel_id===(modal.channelId||state.selected.id)&&(state.showArchived||!t.archived)).map(t=>`<button class="browser-thread" data-action="open-target" data-type="thread" data-id="${t.id}">${icon('threads',19)}<span><b>${esc(t.name)}</b><small>${esc(agent(t.agent_id)?.name||'Team thread')} ${t.archived?'· Archived':''}</small></span>${icon('chevron',15)}</button>`).join('')||'<p class="muted-paragraph">No threads in this channel yet.</p>'}<button class="button-primary" data-action="create-thread" data-channel="${modal.channelId||state.selected.id}">${icon('plus',16)} New Thread</button></div>`,{wide:true});
 case 'edit-profile':return modalFrame('Edit Profile',`<form data-form="edit-profile" class="modal-form">${field('DISPLAY NAME',input('displayName',me().display_name,'required maxlength="70" autofocus'))}${field('STATUS',select('status',opts([['online','Online'],['idle','Idle'],['busy','Do Not Disturb'],['invisible','Invisible']],me().status)))}<div class="modal-footer"><button class="button-secondary" type="button" data-action="dismiss-modal">Cancel</button><button class="button-primary" type="submit">Save Profile</button></div></form>`);
 case 'password':return modalFrame('Change Password',`<form data-form="password" class="modal-form">${field('CURRENT PASSWORD','<input class="form-control" name="currentPassword" type="password" required autocomplete="current-password"/>')}${field('NEW PASSWORD','<input class="form-control" name="newPassword" type="password" minlength="10" required autocomplete="new-password"/>')}<div class="modal-footer"><button class="button-primary" type="submit">Change Password</button></div></form>`);
 case 'sessions':return modalFrame('Active Sessions',`<div class="modal-form">${modal.sessions.map(s=>`<div class="settings-info-row"><strong>${s.current?'This session':'Other session'}</strong><span>Expires ${esc(new Date(s.expiresAt).toLocaleDateString())}</span></div>`).join('')}<button class="button-danger" data-action="revoke-sessions">Sign Out Other Sessions</button></div>`);
 case 'help':return modalFrame('About Cord AI',`<div class="modal-form"><p>Cord is a thread-first collaboration workspace for human teams and AI agents.</p><div class="help-line">${icon('threads',18)} Right-click a thread to edit, close, lock, mute, or assign it.</div><div class="help-line">${icon('message-circle',18)} Channels keep conversations organized; threads keep context focused.</div><div class="help-line">${icon('bot',18)} AI agents respond automatically in assigned threads, only when permitted by reply settings.</div><div class="info-banner">The sample agents use simulated responses. External connections require explicit configuration.</div></div>`);
 default:return '';
}}
function menuItem(label,action,{ico='',danger=false,checked=false,disabled=false,id='',type='',extra=''}={}){
  return `<button type="button" class="context-item ${danger?'danger':''}" data-action="${action}" ${id?`data-id="${attr(id)}"`:''} ${type?`data-type="${attr(type)}"`:''} ${extra} ${disabled?'disabled':''}>${ico?icon(ico,17):'<span class="context-placeholder"></span>'}<span>${esc(label)}</span>${checked?icon('check',15):''}</button>`;
}
function menuDivider(){return '<div class="context-divider"></div>'}
function contextBody(){const menu=state.menu;if(!menu)return '';const {kind,id}=menu;
  if(kind==='message'){
    const m=state.messages.find(m=>m.id===id);if(!m)return '';
    let meta;try{meta=JSON.parse(m.metadata||'{}')}catch{meta={}}
    return menuItem(thread(meta.thread_ref)?'Open Thread':'Create Thread','thread-message',{ico:'threads',id})+menuDivider()+menuItem('Reply','reply-message',{ico:'message-square',id})+menuItem('Copy Message','copy-message',{ico:'copy',id});
  }
  if(kind==='thread'){
    const t=thread(id);if(!t)return '';
    const isOwner=admin()||t.author_id===me().id;
    return `${menuItem('Mark As Read','mark-read',{ico:'check',id,type:'thread'})}${menuItem(prefs('thread',id).favorite?'Remove from Favorites':'Add to Favorites','favorite',{ico:'star',id,type:'thread',checked:!!prefs('thread',id).favorite})}${menuDivider()}
      ${menuItem('Join Thread','join-thread',{ico:'users',id})}${menuItem(t.archived?'Reopen Thread':'Close Thread',t.archived?'reopen-thread':'close-thread',{ico:'archive',id,disabled:!isOwner})}${menuItem(t.locked?'Unlock Thread':'Lock Thread',t.locked?'unlock-thread':'lock-thread',{ico:'lock',id,disabled:!isOwner})}${menuItem('Edit Thread','edit-thread',{ico:'edit',id,disabled:!isOwner})}${menuItem('Copy Link','copy-link',{ico:'link',id,type:'thread'})}${menuDivider()}
      ${menuItem(prefs('thread',id).muted?'Unmute Thread':'Mute Thread','toggle-mute',{ico:'bell-off',id,type:'thread',checked:!!prefs('thread',id).muted})}${menuItem('Notification Settings','notifications',{ico:'bell',id,type:'thread'})}${menuItem('Assign Agent','edit-thread',{ico:'bot',id,disabled:!isOwner})}${menuDivider()}
      ${menuItem('Delete Thread','delete-thread',{ico:'trash',danger:true,id,disabled:!isOwner})}${menuDivider()}${menuItem('Copy Thread ID','copy-id',{ico:'copy',id})}`;
  }
  if(kind==='channel'){
    const c=channel(id);if(!c)return '';
    return `${menuItem('Mark As Read','mark-read',{ico:'check',id,type:'channel'})}${menuItem('Create Thread','create-thread',{ico:'threads',id,extra:`data-channel="${id}"`})}${menuItem('Browse Threads','browse-threads',{ico:'message-square',id})}${menuDivider()}
      ${menuItem(prefs('channel',id).muted?'Unmute Channel':'Mute Channel','toggle-mute',{ico:'bell-off',id,type:'channel'})}${menuItem('Notification Settings','notifications',{ico:'bell',id,type:'channel'})}${menuItem('Invite Agent','open-agent-directory',{ico:'bot'})}${menuDivider()}
      ${menuItem('Edit Channel','channel-settings',{ico:'edit',id,disabled:!admin()})}${menuItem('Copy Link','copy-link',{ico:'link',id,type:'channel'})}${menuItem('Delete Channel','delete-channel',{ico:'trash',id,danger:true,disabled:!admin()})}${menuDivider()}${menuItem('Copy Channel ID','copy-id',{ico:'copy',id})}`;
  }
  if(kind==='category'){
    const c=category(id);if(!c)return '';
    return `${menuItem('Mark As Read','mark-read',{ico:'check',id,type:'category'})}${menuDivider()}${menuItem('Collapse Category','toggle-category',{ico:'chevron',id})}${menuItem('Collapse All Categories','collapse-all',{ico:'chevrons-left'})}${menuDivider()}
      ${menuItem(prefs('category',id).muted?'Unmute Category':'Mute Category','toggle-mute',{ico:'bell-off',id,type:'category'})}${menuItem('Notification Settings','notifications',{ico:'bell',id,type:'category'})}${menuDivider()}
      ${menuItem('Move to Top','move-category',{ico:'sort',id,extra:'data-direction="top"',disabled:!admin()})}${menuItem('Move to Bottom','move-category',{ico:'sort',id,extra:'data-direction="bottom"',disabled:!admin()})}${menuDivider()}
      ${menuItem('Edit Category','edit-category',{ico:'edit',id,disabled:!admin()})}${menuItem('Delete Category','delete-category',{ico:'trash',id,danger:true,disabled:!admin()})}${menuDivider()}${menuItem('Copy Category ID','copy-id',{ico:'copy',id})}`;
  }
  if(kind==='sidebar'||kind==='workspace'){
    return `${menuItem(state.hideMuted?'Show Muted Channels':'Hide Muted Channels','hide-muted',{ico:'eye-off',checked:state.hideMuted})}${menuDivider()}
      ${menuItem('Create Channel','create-channel',{ico:'hash',disabled:!admin()})}${menuItem('Create Category','create-category',{ico:'plus',disabled:!admin()})}${menuItem('Invite to Workspace','show-invite',{ico:'friends',disabled:!admin()})}${menuDivider()}${menuItem('Connect Agent','connect-agent',{ico:'bot',disabled:!admin()})}`;
  }
  if(kind==='user')return `${menuItem('User Settings','open-settings',{ico:'settings'})}${menuItem('Edit Profile','edit-profile',{ico:'edit'})}${menuDivider()}${menuItem('Log Out','logout',{ico:'log-out',danger:true})}`;
  return '';
}
function profileBody(){const p=state.profile;if(!p)return '';const item=p.kind==='agent'?agent(p.id):member(p.id);if(!item)return '';
  const name=item.name||item.display_name;const userProfile=p.id===me().id;
  const width=306,x=Math.max(10,Math.min(window.innerWidth-width-10,p.x||90)),y=Math.max(40,Math.min(window.innerHeight-445,p.y||window.innerHeight-480));
  return `<div class="profile-popover" style="left:${x}px;top:${y}px"><div class="profile-cover" style="background:${esc(item.color||'#6d68ac')}"><span class="profile-cover-decoration"></span></div><div class="profile-floating-avatar">${avatar(item,76,p.kind)}</div><div class="profile-card-body"><h3>${esc(name)}</h3><div class="profile-handle">${esc(item.username||item.name)} ${p.kind==='agent'?'<span class="badge-app">APP</span>':''}</div><div class="profile-status"><span class="status-dot"></span>${esc(item.status||'online')}</div><div class="profile-separator"></div>${p.kind==='agent'?`<h4>AGENT PROFILE</h4><p>${esc(item.description||'AI agent for your team.')}</p><div class="profile-agent-type">${icon('terminal',16)} ${esc(item.type||'demo')} connector</div>`:`<h4>ABOUT</h4><p>${userProfile?'Your account in this workspace.':'Team member'}</p>`}<div class="profile-separator"></div><div class="profile-actions">${userProfile?`<button data-action="edit-profile">${icon('edit',16)} Edit Profile</button><button data-action="open-settings">${icon('settings',16)} User Settings</button>`:`<button data-action="create-dm" data-kind="${p.kind}" data-id="${p.id}">${icon('message-square',16)} Message</button>${p.kind==='agent'&&admin()?`<button data-action="edit-agent" data-id="${p.id}">${icon('settings',16)} Configure Agent</button>`:''}`}</div></div></div>`;
}
function searchView(){if(!state.searchOpen)return '';
 return `<div class="search-shade" data-action="close-search"><div class="search-dialog" data-stop-click="true"><div class="search-input-wrap">${icon('search',22)}<input id="global-search" autocomplete="off" value="${attr(state.searchQuery)}" placeholder="Search messages, threads, channels or people…" /><span>ESC</span></div><div class="search-results"><div class="search-label">${state.searchQuery.length>=2?`RESULTS FOR “${esc(state.searchQuery)}”`:'QUICK NAVIGATION'}</div>
   ${state.searchQuery.length>=2?`${state.searchResults.length?state.searchResults.map(m=>`<button class="search-result" data-action="search-go" data-type="${m.target_type}" data-id="${m.target_id}">${icon(m.target_type==='thread'?'threads':m.target_type==='channel'?'hash':'message-square',20)}<span><strong>${esc(m.content.slice(0,95))}</strong><small>${esc(m.target_type)} · ${prettyDate(m.created_at)}</small></span>${icon('chevron',15)}</button>`).join(''):'<div class="search-empty">No messages found yet.</div>'}`:
     `<button data-action="goto-workspace">${icon('hash',18)} Go to team channels</button><button data-action="open-agent-directory">${icon('bot',18)} Open agent directory</button><button data-action="open-settings">${icon('settings',18)} User Settings</button>`}
  </div><div class="search-footer"><span><kbd>↵</kbd> Open result</span><span><kbd>ESC</kbd> Close</span><span>CORD SEARCH</span></div></div></div>`;
}
function captureModalForm(){const form=document.querySelector('#overlays form[data-form]');if(!form||state.busy)return null;return {kind:form.dataset.form,fields:[...form.elements].filter(el=>el.name).map(el=>({name:el.name,type:el.type,value:el.value,checked:el.checked})),focus:document.activeElement?.name,start:document.activeElement?.selectionStart,end:document.activeElement?.selectionEnd};}
function renderOverlays(saved=captureModalForm()){const host=document.getElementById('overlays');if(!host)return;
 host.innerHTML=`${state.menu?`<div class="context-shade" data-action="close-menu"></div><div class="context-menu" style="left:${Math.max(4,Math.min(window.innerWidth-240,state.menu.x))}px;top:${Math.max(4,Math.min(window.innerHeight-490,state.menu.y))}px">${contextBody()}</div>`:''}
 ${state.profile?profileBody():''}${state.modal?modalBody():''}${searchView()}${data().approvals?.length&&!state.modal?`<button class="approval-inbox" data-action="open-run-log">${icon('shield-check',18)} ${data().approvals.length} agent approval${data().approvals.length>1?'s':''} pending</button>`:''}${state.toast?`<div class="toast ${state.toast.kind}">${icon(state.toast.kind==='error'?'info':'check',17)}<span>${esc(state.toast.message)}</span><button data-action="dismiss-toast" title="Dismiss">${icon('close',16)}</button></div>`:''}`;
 const form=host.querySelector('form[data-form]');if(saved&&form?.dataset.form===saved.kind){for(const value of saved.fields){for(const el of form.elements){if(el.name!==value.name)continue;if(el.type==='radio'){if(el.value===value.value)el.checked=value.checked;}else if(el.type==='checkbox')el.checked=value.checked;else el.value=value.value;}}const focus=[...form.elements].find(el=>el.name===saved.focus);focus?.focus();if(saved.start!=null&&['text','password','textarea'].includes(focus?.type))focus.setSelectionRange(saved.start,saved.end);}
}
function render({keepScroll=false}={}){
  if(!state.data)return;
  const savedForm=captureModalForm();
  const old=document.querySelector('#chat-scroll');const oldBottom=old?old.scrollHeight-old.clientHeight-old.scrollTop<130:true,oldTop=old?.scrollTop||0;
  const id=state.selected.type+':'+state.selected.id;const changed=state.lastSelection!==id;state.lastSelection=id;
  app.innerHTML=(state.screen==='edit-thread'?threadEditor():state.screen==='settings'?settingsView():chatShell())+'<div id="overlays"></div>';
  renderOverlays(savedForm);const scroller=document.querySelector('#chat-scroll');if(scroller){if(changed||oldBottom||!keepScroll)scroller.scrollTop=scroller.scrollHeight;else scroller.scrollTop=oldTop}
  if(state.modal?.kind==='create-thread')requestAnimationFrame(()=>app.querySelector('.modal [autofocus]')?.focus());
}
function renderMessagesOnly(){if(state.screen!=='chat')return;const old=document.querySelector('.conversation-area'),scroll=document.querySelector('#chat-scroll');if(!old)return;
 const wasBottom=scroll?scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100:true;const top=scroll?.scrollTop||0;
 old.innerHTML=messagesPanel()+rightPanel();const next=document.querySelector('#chat-scroll');if(next)next.scrollTop=wasBottom?next.scrollHeight:top;
}
function menuOpen(kind,id,event){state.menu={kind,id,x:event.clientX,y:event.clientY};state.profile=null;state.modal=null;renderOverlays()}
function openModal(kind,extra={}){state.modal={kind,...extra};state.menu=null;state.profile=null;state.searchOpen=false;renderOverlays();requestAnimationFrame(()=>app.querySelector('.modal [autofocus]')?.focus())}
function closeTransient(){state.menu=null;state.modal=null;state.profile=null;state.searchOpen=false;renderOverlays()}
async function clipboard(text){try{await navigator.clipboard.writeText(text);toast('Copied to clipboard')}catch{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();toast('Copied to clipboard')}}
function openSettings(section='account'){state.selectedSettings=section;state.screen='settings';closeTransient();render()}
function exitSettings(){state.screen='chat';closeTransient();render()}
function editThread(id){state.selected={type:'thread',id};state.screen='edit-thread';state.menu=null;render()}
function openSearch(){state.searchOpen=true;state.menu=null;state.modal=null;state.profile=null;state.searchResults=[];state.searchQuery='';renderOverlays();requestAnimationFrame(()=>document.querySelector('#global-search')?.focus())}
async function updatePref(type,id,patch){const existing=prefs(type,id);await api('/preferences',{method:'POST',body:{targetType:type,targetId:id,...patch}});state.menu=null;await loadData({keepScroll:true});}
async function doAction(button,event){const action=button.dataset.action,id=button.dataset.id,type=button.dataset.type;
 try{switch(action){
  case 'close-menu':state.menu=null;renderOverlays();break;
  case 'dismiss-toast':state.toast=null;renderOverlays();break;
  case 'dismiss-modal':state.modal=null;renderOverlays();break;
  case 'close-search':state.searchOpen=false;renderOverlays();break;
  case 'goto-dm':state.dmView=true;state.screen='chat';put('dmView',true);if(D()[0])selectTarget('dm',D()[0].id);else render();break;
  case 'goto-workspace':state.dmView=false;state.screen='chat';put('dmView',false);if(C()[1]||C()[0])selectTarget('channel',(C()[1]||C()[0]).id);else render();break;
  case 'open-target':selectTarget(type,id);break;
  case 'toggle-category':if(state.collapsed.has(id))state.collapsed.delete(id);else state.collapsed.add(id);put('collapsed',[...state.collapsed]);state.menu=null;render();break;
  case 'collapse-all':K().forEach(c=>state.collapsed.add(c.id));put('collapsed',[...state.collapsed]);state.menu=null;render();break;
  case 'hide-muted':state.hideMuted=!state.hideMuted;put('hideMuted',state.hideMuted);state.menu=null;render();break;
  case 'create-channel':openModal('create-channel',{categoryId:button.dataset.cat||category(state.menu?.id)?.id||K()[0]?.id});break;
  case 'create-category':openModal('create-category');break;
  case 'create-thread':openModal('create-thread',{channelId:button.dataset.channel|| (state.selected.type==='thread'?thread(state.selected.id)?.channel_id:state.selected.id)});break;
  case 'browse-threads':openModal('threads-browser',{channelId:id||state.selected.id});break;
  case 'filter-threads':state.showArchived=button.dataset.mode==='all';renderOverlays();render();break;
  case 'channel-settings':openModal('edit-channel',{id});break;
  case 'edit-category':openModal('edit-category',{id});break;
  case 'delete-thread':openModal('delete-confirm',{id:id||state.selected.id,targetType:'thread'});break;
  case 'delete-channel':openModal('delete-confirm',{id,targetType:'channel'});break;
  case 'delete-category':openModal('delete-confirm',{id,targetType:'category'});break;
  case 'delete-agent':openModal('delete-confirm',{id,targetType:'agent'});break;
  case 'confirm-delete':{
    const m=state.modal;if(!m)return;await api(`/${m.targetType==='category'?'categories':m.targetType==='thread'?'threads':m.targetType==='agent'?'agents':'channels'}/${m.id}`,{method:'DELETE'});
    state.modal=null;state.menu=null;if(state.selected.id===m.id)state.selected={type:'channel',id:C()[0]?.id};await loadData();toast('Deleted successfully');break;
  }
  case 'edit-thread':editThread(id||state.selected.id);break;
  case 'exit-editor':state.screen='chat';render();break;
  case 'join-thread':case 'leave-thread':case 'close-thread':case 'reopen-thread':case 'lock-thread':case 'unlock-thread':{
    const name={'join-thread':'join','leave-thread':'leave','close-thread':'close','reopen-thread':'reopen','lock-thread':'lock','unlock-thread':'unlock'}[action];
    await api('/thread-actions',{method:'POST',body:{threadId:id,action:name}});await loadData({keepScroll:true});toast(`Thread ${name==='close'?'closed':name==='reopen'?'reopened':name==='lock'?'locked':name==='unlock'?'unlocked':name==='join'?'joined':'left'}`);break;
  }
  case 'mark-read':{
    if(type==='category'){const channels=C().filter(c=>c.category_id===id);for(const c of channels)await api('/read',{method:'POST',body:{targetType:'channel',targetId:c.id}})}
    else await api('/read',{method:'POST',body:{targetType:type||state.selected.type,targetId:id||state.selected.id}});
    state.menu=null;toast('Marked as read');break;
  }
  case 'toggle-mute':{
    const t=type||state.selected.type;const key=id||state.selected.id;await updatePref(t,key,{muted:!prefs(t,key).muted});toast(prefs(t,key).muted?'Muted':'Unmuted');break;
  }
  case 'favorite':{
    const t=type||state.selected.type;const key=id||state.selected.id;await updatePref(t,key,{favorite:!prefs(t,key).favorite});toast(prefs(t,key).favorite?'Added to favorites':'Removed from favorites');break;
  }
  case 'notifications':openModal('notifications',{id,targetType:type});break;
  case 'set-notif':await updatePref(button.dataset.target,id,{notificationLevel:button.dataset.level,muted:button.dataset.level==='none'});state.modal=null;renderOverlays();toast('Notification preference saved');break;
  case 'copy-id':clipboard(id||state.selected.id);state.menu=null;renderOverlays();break;
  case 'copy-link':{
    const link=new URL(window.location.href);link.searchParams.set('view',type||state.selected.type);link.searchParams.set('id',id||state.selected.id);clipboard(link.href);state.menu=null;renderOverlays();break;
  }
  case 'move-category':{
    const cat=category(id),direction=button.dataset.direction;await api('/categories/'+id,{method:'PATCH',body:{name:cat.name,position:direction==='top'?-1:9999}});await loadData();break;
  }
  case 'workspace-menu':menuOpen('workspace',null,event);break;
  case 'open-room-menu':menuOpen(state.selected.type==='thread'?'thread':state.selected.type==='channel'?'channel':'user',state.selected.id,event);break;
  case 'show-invite':openModal('invite');break;
  case 'generate-invite':{const r=await api('/invites',{method:'POST',body:{workspaceId:data().workspace.id}});const link=new URL(window.location.href);link.searchParams.set('invite',r.code);state.modal.link=link.href;renderOverlays();break}
  case 'copy-invite':clipboard(state.modal.link);break;
  case 'connect-agent':openModal('easy-connect');break;
  case 'advanced-connect':openModal('advanced-agent');break;
  case 'copy-agent-prompt':clipboard(state.modal.prompt);break;
  case 'refresh-connection':await loadData({keepScroll:true});toast(agent(state.modal?.agentId)?.status==='online'?'Agent connected':'Waiting for your agent to connect');break;
  case 'reconnect-agent':{const a=agent(id);const r=await api('/agent-connections',{method:'POST',body:{workspaceId:data().workspace.id,agentId:id,runtime:a.runtime}});openModal('easy-connect',r);break;}
  case 'pause-agent':await api(`/agent-connections/${id}/pause`,{method:'POST',body:{paused:!agent(id).paused}});await loadData({keepScroll:true});break;
  case 'revoke-agent':await api(`/agent-connections/${id}/revoke`,{method:'POST',body:{}});await loadData({keepScroll:true});toast('Agent access revoked');break;
  case 'test-agent':{const r=await api(`/agent-connections/${id}/test`,{method:'POST',body:{}});await loadData({messages:false});selectTarget('dm',r.dmId);break;}
  case 'cancel-run':await api(`/runs/${id}/cancel`,{method:'POST',body:{}});await loadData({keepScroll:true});break;
  case 'decide-approval':await api(`/approvals/${id}`,{method:'POST',body:{decision:button.dataset.decision}});await loadData({keepScroll:true});break;
  case 'export-data':{const r=await api('/account/export');const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='cord-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
  case 'clear-local':for(const key of Object.keys(localStorage))if(key.startsWith('cord:'))localStorage.removeItem(key);state.drafts={};state.collapsed=new Set();state.hideMuted=false;render();toast('Browser preferences reset');break;
  case 'change-password':openModal('password');break;
  case 'show-sessions':{const r=await api('/account/sessions');openModal('sessions',r);break;}
  case 'revoke-sessions':await api('/account/sessions',{method:'DELETE'});state.modal=null;renderOverlays();toast('Other sessions signed out');break;
  case 'enable-notifications':if('Notification' in window){const permission=await Notification.requestPermission();toast(permission==='granted'?'Desktop notifications enabled':'Desktop notification permission was not granted');}else toast('Desktop notifications are unavailable in this browser');break;
  case 'edit-agent':openModal(agent(id)?.type==='bridge'?'connection-settings':'edit-agent',{id});break;
  case 'open-agent-directory':openModal('agent-directory');break;
  case 'open-run-log':openModal('runs');break;
  case 'new-dm':openModal('new-dm');break;
  case 'dm-agent':case 'create-dm':{
    const kind=button.dataset.kind||'agent';const r=await api('/dms',{method:'POST',body:{workspaceId:data().workspace.id,...(kind==='agent'?{agentId:id}:{userId:id})}});
    await loadData({messages:false});selectTarget('dm',r.id);break;
  }
  case 'open-profile':{
    const kind=button.dataset.kind==='agent'?'agent':'user';const rect=button.getBoundingClientRect();state.profile={kind,id,x:Math.max(15,rect.left),y:Math.min(window.innerHeight-440,rect.top+35)};state.menu=null;renderOverlays();break;
  }
  case 'edit-profile':openModal('edit-profile');break;
  case 'open-settings':openSettings();break;
  case 'exit-settings':exitSettings();break;
  case 'settings-section':state.selectedSettings=button.dataset.section;render();break;
  case 'settings-search':openSearch();break;
  case 'show-friends':openModal('new-dm');break;
  case 'show-help':openModal('help');break;
  case 'logout':await api('/auth/logout',{method:'POST',body:{}});window.location.reload();break;
  case 'search':openSearch();break;
  case 'search-go':state.searchOpen=false;selectTarget(type,id);break;
  case 'toggle-members':state.memberPanel=!state.memberPanel;put('memberPanel',state.memberPanel);render();break;
  case 'mobile-menu':state.sidebarOpen=!state.sidebarOpen;render();break;
  case 'thread-message':{
    const m=state.messages.find(m=>m.id===id);if(!m||state.selected.type!=='channel')break;
    let meta;try{meta=JSON.parse(m.metadata||'{}')}catch{meta={}}
    if(thread(meta.thread_ref)){selectTarget('thread',meta.thread_ref);break}
    openModal('create-thread',{channelId:state.selected.id,sourceMessageId:m.id,sourceContent:m.content,sourceAuthorType:m.author_type,sourceAuthorId:m.author_id,name:m.content.replace(/\s+/g,' ').trim().slice(0,120)});break;
  }
  case 'reply-message':{
    state.menu=null;renderOverlays();
    const m=state.messages.find(m=>m.id===id);if(!m)break;const key=state.selected.type+':'+state.selected.id;state.drafts[key]=`> ${m.content.slice(0,150).replace(/\n/g,' ')}\n\n`+(state.drafts[key]||'');renderMessagesOnly();document.querySelector('#message-input')?.focus();break;
  }
  case 'copy-message':{state.menu=null;renderOverlays();const m=state.messages.find(m=>m.id===id);if(m)clipboard(m.content);break;}
  case 'delete-message':if(!confirm('Delete this message permanently?'))break;await api('/messages/'+id,{method:'DELETE'});await loadMessages();renderMessagesOnly();break;
  case 'react-message':{
    const m=state.messages.find(m=>m.id===id);if(!m)break;const key=state.selected.type+':'+state.selected.id;state.drafts[key]=(state.drafts[key]||'')+'👍';renderMessagesOnly();document.querySelector('#message-input')?.focus();toast('Emoji inserted — reactions are planned for the next iteration');break;
  }
  case 'composer-add':openModal(state.selected.type==='dm'?'easy-connect':'create-thread',{channelId:state.selected.type==='thread'?thread(state.selected.id)?.channel_id:state.selected.id});break;
  case 'insert-emoji':case 'insert-mention':{
    const key=state.selected.type+':'+state.selected.id;state.drafts[key]=(state.drafts[key]||'')+(action==='insert-emoji'?'🙂':`@${A()[0]?.name||'agent'} `);renderMessagesOnly();document.querySelector('#message-input')?.focus();break;
  }
  case 'toggle-mic':case 'toggle-headphones':toast('Voice is outside this thread-first MVP.');break;
  default:console.warn('Unrecognized action',action);break;
 }}catch(err){handleError(err)}
}
function formValues(form){const values=Object.fromEntries(new FormData(form).entries());for(const check of form.querySelectorAll('input[type=checkbox]'))values[check.name]=check.checked;return values}
async function submitForm(form,event){event.preventDefault();const kind=form.dataset.form;const values=formValues(form);if(state.busy)return;state.busy=true;const button=form.querySelector('button[type=submit]');if(button)button.disabled=true;
 try{
  if(kind==='easy-connect'){
    const r=await api('/agent-connections',{method:'POST',body:{...values,workspaceId:data().workspace.id}});state.modal={kind:'easy-connect',...r};await loadData({keepScroll:true});
  }else if(kind==='connection-settings'){
    await api(`/agent-connections/${form.dataset.id}/settings`,{method:'PATCH',body:{...values,timeoutSeconds:Number(values.timeoutSeconds)}});await loadData({keepScroll:true});toast('Agent settings saved');
  }else if(kind==='preferences'){
    const patch={...values,fontSize:Number(values.fontSize)};delete patch.workspaceId;await api('/settings',{method:'PATCH',body:patch});await loadData({keepScroll:true});toast('Preferences saved');
  }else if(kind==='workspace'){
    await api('/workspace',{method:'PATCH',body:{...values,workspaceId:data().workspace.id}});await loadData({keepScroll:true});toast('Workspace saved');
  }else if(kind==='password'){
    await api('/account/password',{method:'POST',body:values});state.modal=null;renderOverlays();toast('Password changed; other sessions signed out');
  }else if(kind==='message'){
    const text=String(form.querySelector('textarea')?.value||'').trim();if(!text)return;
    const selected={...state.selected},key=selected.type+':'+selected.id;
    await api('/messages',{method:'POST',body:{targetType:selected.type,targetId:selected.id,content:text}});
    state.drafts[key]='';await loadMessages();renderMessagesOnly();const sc=document.querySelector('#chat-scroll');if(sc)sc.scrollTop=sc.scrollHeight;
  }else if(kind==='create-category'){
    await api('/categories',{method:'POST',body:{workspaceId:data().workspace.id,name:values.name}});state.modal=null;await loadData();toast('Category created');
  }else if(kind==='create-channel'){
    const result=await api('/channels',{method:'POST',body:{workspaceId:data().workspace.id,name:values.name,categoryId:values.categoryId||null,description:values.description}});state.modal=null;await loadData({messages:false});selectTarget('channel',result.id);toast('Channel created');
  }else if(kind==='create-thread'){
    const result=await api('/threads',{method:'POST',body:{channelId:state.modal.sourceMessageId?state.modal.channelId:values.channelId,sourceMessageId:state.modal.sourceMessageId,name:values.name,firstMessage:values.firstMessage,agentId:values.agentId||null,agentMode:values.agentMode}});state.modal=null;await loadData({messages:false});selectTarget('thread',result.id);toast('Thread created');
  }else if(kind==='edit-thread'){
    await api(`/threads/${state.selected.id}`,{method:'PATCH',body:{name:values.name,slowmode:Number(values.slowmode),autoHideDays:Number(values.autoHideDays),spoiler:values.spoiler,archived:values.archived,locked:values.locked,agentId:values.agentId,agentMode:values.agentMode}});
    state.screen='chat';await loadData();toast('Thread settings saved');
  }else if(kind==='edit-category'){
    await api('/categories/'+state.modal.id,{method:'PATCH',body:{name:values.name}});state.modal=null;await loadData();toast('Category updated');
  }else if(kind==='edit-channel'){
    await api('/channels/'+state.modal.id,{method:'PATCH',body:{name:values.name,description:values.description,categoryId:values.categoryId||null}});state.modal=null;await loadData();toast('Channel updated');
  }else if(kind==='connect-agent'||kind==='edit-agent'){
    const existing=kind==='edit-agent';const endpoint='/agents'+(existing?'/'+state.modal.id:'');
    await api(endpoint,{method:existing?'PATCH':'POST',body:{...values,workspaceId:data().workspace.id}});
    state.modal=null;await loadData();openModal('agent-directory');toast(existing?'Agent connector updated':'Agent connected');
  }else if(kind==='edit-profile'){
    await api('/profile',{method:'PATCH',body:{displayName:values.displayName,status:values.status}});state.modal=null;await loadData();toast('Profile updated');
  }else if(kind==='login'){
    await api('/auth/login',{method:'POST',body:values});window.location.reload();
  }else if(kind==='register'){
    await api('/auth/register',{method:'POST',body:values});window.location.href='/';
  }
 }catch(err){handleError(err)}finally{state.busy=false;if(button)button.disabled=false}
}
function loginScreen(){
 const invite=new URLSearchParams(location.search).get('invite'),registering=!!invite||state.setupRequired;
 app.innerHTML=`<div class="auth-page"><div class="auth-halo"></div><div class="auth-card"><div class="auth-brand"><span class="brand-large">C</span><div><b>Cord AI</b><small>Humans + agents. One team.</small></div></div><h1>${registering?'Join your team':'Welcome back'}</h1><p>${registering?'Create your account to enter this workspace.':'Your conversations, channels and AI agents in one place.'}</p><form data-form="${registering?'register':'login'}">${registering?field('DISPLAY NAME',input('displayName','','required placeholder="Your name"')):''}${field('USERNAME',input('username','','required autocomplete="username" placeholder="Your username"'))}${field('PASSWORD',`<input class="form-control" type="password" name="password" minlength="${registering?'10':'1'}" required autocomplete="${registering?'new-password':'current-password'}" placeholder="${registering?'10+ characters':'Password'}"/>`)}${registering?`<input type="hidden" name="inviteCode" value="${attr(invite||'')}"/>`:''}<button type="submit" class="button-primary full">${registering?'Create Account':'Sign In'}</button></form><div class="auth-foot">No Discord account required · Your own workspace</div></div></div>`;
}
let onRefresh=null;
document.addEventListener('contextmenu',event=>{
 if(!state.data||state.screen!=='chat')return;
 const target=event.target.closest('[data-context]');if(!target)return;
 event.preventDefault();event.stopPropagation();menuOpen(target.dataset.context,target.dataset.id,event);
});
document.addEventListener('click',event=>{
 const target=event.target.closest('[data-action]');if(!target){if(state.menu||state.profile){state.menu=null;state.profile=null;renderOverlays()}return}
 if(target.dataset.action==='dismiss-modal'&&event.target.closest('[data-stop-click]')&&target===event.target.closest('.modal-scrim'))return;
 event.preventDefault();void doAction(target,event);
});
document.addEventListener('submit',event=>{const form=event.target.closest('[data-form]');if(form)void submitForm(form,event)});
document.addEventListener('input',event=>{
 if(event.target.id==='message-input'){const key=state.selected.type+':'+state.selected.id;state.drafts[key]=event.target.value;event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,220)+'px'}
 if(event.target.id==='global-search'){
   state.searchQuery=event.target.value;const q=state.searchQuery;
   clearTimeout(window._cordSearchTimer);window._cordSearchTimer=setTimeout(async()=>{if(q.length<2){state.searchResults=[];renderOverlays();return}try{const r=await api('/search?q='+encodeURIComponent(q));if(state.searchQuery!==q)return;state.searchResults=r.messages;const node=document.querySelector('.search-results');if(node){const focused=document.activeElement===document.querySelector('#global-search');const pos=document.querySelector('#global-search')?.selectionStart;renderOverlays();const newInput=document.querySelector('#global-search');if(focused&&newInput){newInput.focus();if(pos!=null)newInput.setSelectionRange(pos,pos)}}}catch(error){handleError(error)}},250);
 }
});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){
   if(state.searchOpen||state.modal||state.menu||state.profile){closeTransient();return}
   if(state.screen==='edit-thread'){state.screen='chat';render();return}
   if(state.screen==='settings'){exitSettings();return}
 }
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch()}
 if((event.ctrlKey||event.metaKey)&&event.key===','){event.preventDefault();openSettings()}
 if(event.target.id==='message-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&(data().settings?.enterToSend!==false||event.ctrlKey||event.metaKey)){event.preventDefault();event.target.closest('form')?.requestSubmit()}
});
async function start(){
 try{
  const config=await api('/auth/config');state.setupRequired=config.setupRequired;
  if(state.setupRequired){loginScreen();return}
  if(new URLSearchParams(location.search).has('invite')){loginScreen();return}
  let r;try{r=await api('/me')}catch(err){
    try{await api('/auth/demo',{method:'POST',body:{}});r=await api('/me')}catch{loginScreen();return}
  }
  const route=new URLSearchParams(location.search);if(route.get('view')&&route.get('id')){state.selected={type:route.get('view'),id:route.get('id')};state.dmView=route.get('view')==='dm';history.replaceState(null,'','/')}
  await loadData();onRefresh=initEvents();if(current())markRead(state.selected.type,state.selected.id);
 }catch(err){console.error(err);app.innerHTML=`<div class="error-start"><h1>Couldn't load Cord AI</h1><p>${esc(err.message)}</p><button onclick="location.reload()">Retry</button></div>`}
}
setInterval(()=>{
 if(document.hidden||state.busy||!state.data)return;
 const watching=['agent-directory','connection-settings'].includes(state.modal?.kind)||(state.modal?.kind==='easy-connect'&&state.modal.prompt)||(state.screen==='settings'&&['agents','runs','security'].includes(state.selectedSettings));
 if(watching)loadData({messages:false,keepScroll:true}).catch(handleError);
},15_000);
start();
