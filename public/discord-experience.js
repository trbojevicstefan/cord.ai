// Cord conversation UX: first-class mentions, replies, reactions, pinned messages,
// uploads, slash commands and keyboard-first navigation. No framework/dependencies.
// Every server-changing interaction goes through the authenticated Cord API.
const EMOJI_SECTIONS={
  Frequently:['👍','❤️','😂','🔥','🎉','✅','👀','🚀','💯','🙌','👏','💡','🤔','👎'],
  Faces:['😀','😃','😄','😁','😆','🥹','😊','😍','😘','😎','🥳','😭','😅','🤣','😴','🤯','😬','🤝','🙏'],
  Work:['💻','🧠','🤖','⚡','🧩','🛠️','📌','📣','📝','📋','📊','📈','📎','🔗','🔒','🐛','🚧','💬','🔔','💾','🗂️'],
  Symbols:['💜','💙','💚','🧡','💛','🖤','🤍','❗','❓','⭕','❌','⭐','✨','☀️','🌙','🌎']
};
const SLASH=[
  {command:'/thread',help:'Create a thread in this channel',placeholder:'/thread My new thread'},
  {command:'/shrug',help:'Append ¯\\_(ツ)_/¯ to your message',placeholder:'/shrug I guess'},
  {command:'/me',help:'Send an action / status message',placeholder:'/me is working on the UI'},
  {command:'/roll',help:'Roll a number from 1 to 100 (or another limit)',placeholder:'/roll 20'},
  {command:'/agent',help:'Open the agent directory',placeholder:'/agent'},
  {command:'/invite',help:'Invite teammates to your workspace',placeholder:'/invite'},
  {command:'/help',help:'Open the help center',placeholder:'/help'},
];
const EMOJI_NAMES={'👍':'thumbs up like','❤️':'heart love','😂':'laugh joy','🔥':'fire lit','🎉':'party celebration','✅':'check yes done','👀':'eyes looking','🚀':'rocket launch','💯':'hundred','🙌':'raised hands','👏':'clap','💡':'lightbulb idea','🤔':'thinking','👎':'thumbs down','😀':'grinning happy','😍':'love heart eyes','😭':'crying','🧠':'brain','🤖':'robot agent','⚡':'lightning speed','🧩':'puzzle','🛠️':'tools','📌':'pin','📣':'announcement','📝':'notes','📋':'clipboard','📊':'chart','📈':'trending','📎':'paperclip attachment','🔗':'link','🔒':'lock','🐛':'bug','🚧':'construction work','💬':'speech chat','🔔':'bell notification','💾':'save disk','🗂️':'folder files','⭐':'star favorite','✨':'sparkles'};
const filePretty=bytes=>bytes>1024*1024?`${(bytes/1048576).toFixed(1)} MB`:`${Math.max(1,Math.ceil(bytes/1024))} KB`;
const toText=value=>String(value??'');
const own=(o,key)=>Object.prototype.hasOwnProperty.call(o,key);
export function createDiscordExperience({api,esc,icon,getData,getState,getMember,getAgent,getChannel,isAdmin,toast,loadMessages,renderMessagesOnly,selectTarget,openModal,onHelp}){
  const compose=new Map();let suggest=null,popup=null,pins=null,menuOwner=null,activeUpload=0;
  const state=getState;
  const key=()=>`${state().selected.type}:${state().selected.id}`;
  const slot=()=>{const k=key();if(!compose.has(k))compose.set(k,{reply:null,uploads:[]});return compose.get(k)};
  const typingByTarget=new Map();let lastTypingSent=0;
  const typingMarkup=()=>`<div id="discord-typing-strip" class="discord-typing-strip" aria-live="polite">${typingMarkupInner()}</div>`;
  const typingMarkupInner=()=>{
    const keyNow=key(),active=typingByTarget.get(keyNow)||new Map(),live=[...active.values()].filter(v=>Date.now()-v.at<8000);
    if(!live.length)return '';
    const names=live.slice(0,3).map(v=>v.name);
    const title=names.length===1?`${names[0]} is typing`:`${names.join(', ')} are typing`;
    return `<span class="discord-typing-bubbles"><i></i><i></i><i></i></span><strong>${esc(title)}</strong><span>…</span>`;
  };
  const refreshTyping=()=>{const host=document.getElementById('discord-typing-strip');if(host)host.innerHTML=typingMarkupInner()};
  const receiveTyping=event=>{
    if(!event||event.userId===getData().user?.id||!['channel','thread','dm'].includes(event.targetType)||!event.targetId)return;
    const target=`${event.targetType}:${event.targetId}`,active=typingByTarget.get(target)||new Map();
    active.set(event.userId,{name:toText(event.name).slice(0,60),at:Date.now()});typingByTarget.set(target,active);
    refreshTyping();setTimeout(()=>{const item=active.get(event.userId);if(item&&Date.now()-item.at>=7800){active.delete(event.userId);refreshTyping()}},8000);
  };
  const typingEvent=()=>{
    if(Date.now()-lastTypingSent<3300||!el()?.value.trim())return;
    lastTypingSent=Date.now();const selected={...state().selected};
    void api('/social/typing',{method:'POST',body:{targetType:selected.type,targetId:selected.id}}).catch(()=>{});
  };
  const save=()=>{const el=document.getElementById('message-input');if(el)state().drafts[key()]=el.value};
  const heading=()=>{
    const s=slot();return `${s.reply?`<div class="discord-reply-bar"><div class="discord-reply-icon">↳</div><div class="discord-reply-label"><span>Replying to <strong>${esc(nameOf(s.reply))}</strong></span><small>${esc(s.reply.content.slice(0,150))}</small></div><button type="button" data-action="discord-cancel-reply" aria-label="Cancel reply" title="Cancel reply">×</button></div>`:''}
      ${s.uploads.length?`<div class="discord-upload-tray">${s.uploads.map(f=>`<div class="discord-upload-chip ${f.pending?'pending':''}"><span class="discord-upload-glyph">${f.mime?.startsWith('image/')?'▧':'▤'}</span><span><b title="${esc(f.filename)}">${esc(f.filename)}</b><small>${f.pending?'Uploading…':filePretty(f.bytes)}</small></span><button type="button" data-action="discord-remove-file" data-id="${esc(f.id)}" aria-label="Remove attachment ${esc(f.filename)}">×</button></div>`).join('')}</div>`:''}`;
  };
  const composerHeader=()=>`<div id="discord-compose-header" class="discord-compose-header">${heading()}</div>`;
  const updateHeader=()=>{const node=document.getElementById('discord-compose-header');if(node)node.innerHTML=heading()};
  const canonicalNames=id=>{
    const user=getMember(id);if(user)return {name:user.display_name,kind:'user',avatar:user.avatar};
    const agent=getAgent(id);if(agent)return {name:agent.name,kind:'agent',avatar:agent.avatar};
    return null;
  };
  const nameOf=m=>m.author_type==='agent'?getAgent(m.author_id)?.name||'Agent':getMember(m.author_id)?.display_name||'Team member';
  const escapedTag=(id,tag)=>{const entity=canonicalNames(id);return entity?`<button class="discord-mention discord-mention-${entity.kind}" data-action="open-profile" data-kind="${entity.kind}" data-id="${esc(id)}" title="View ${esc(entity.name)}">@${esc(entity.name)}</button>`:`<span class="discord-mention-missing">@unknown</span>`};
  function enrichMarkdown(html){
    // parseMarkdown() has already escaped raw HTML; transform only canonical IDs.
    return html.replace(/~~([^~<>]+)~~/g,'<del>$1</del>')
      .replace(/\|\|([^|<>]+)\|\|/g,'<button type="button" class="discord-spoiler" data-action="discord-spoiler" title="Click to reveal spoiler">$1</button>')
      .replace(/&lt;@([\w-]+)&gt;/g,(_,id)=>escapedTag(id,'@'))
      .replace(/&lt;#([\w-]+)&gt;/g,(_,id)=>{const channel=getChannel(id);return channel?`<button data-action="open-target" data-type="channel" data-id="${esc(id)}" class="discord-mention discord-channel-mention">#${esc(channel.name)}</button>`:'<span class="discord-mention-missing">#unknown-channel</span>'})
      .replace(/(^|\s)@(everyone|here)\b/gi,'$1<span class="discord-everyone">@$2</span>');
  }
  const messageIntro=m=>m.reply?`<button class="discord-reply-reference" data-action="discord-jump-reply" data-id="${esc(m.reply.id)}" title="Jump to replied message"><span class="discord-reply-line">╰</span><span class="discord-reply-reference-icon">↪</span><b>${esc(m.reply.deleted?'Deleted message':nameOf(m.reply))}</b><span>${esc(m.reply.deleted?'Original message was removed':m.reply.content.replace(/\s+/g,' ').slice(0,120))}</span></button>`:'';
  const messageBottom=m=>`${m.edited_at?`<span class="discord-edited-label" title="Edited ${esc(new Date(m.edited_at).toLocaleString())}">(edited)</span>`:''}${m.pinned?`<span class="discord-pinned-tag" title="Pinned message">📌 Pinned</span>`:''}
    ${(m.attachments||[]).length?`<div class="discord-attachments">${m.attachments.map(f=>f.mime.startsWith('image/')?`<a class="discord-image-attachment" href="${esc(f.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(f.filename)}"><img src="${esc(f.url)}" alt="${esc(f.filename)}" loading="lazy"/><span>${esc(f.filename)} · ${filePretty(f.bytes)}</span></a>`:`<a class="discord-file-attachment" href="${esc(f.url)}" download="${esc(f.filename)}" title="Download ${esc(f.filename)}"><span>▤</span><span><b>${esc(f.filename)}</b><small>${esc(f.mime)} · ${filePretty(f.bytes)}</small></span><strong>↓</strong></a>`).join('')}</div>`:''}
    ${(m.reactions||[]).length?`<div class="discord-reactions">${m.reactions.map(r=>`<button type="button" class="discord-reaction ${r.mine?'mine':''}" data-action="discord-reaction-toggle" data-id="${esc(m.id)}" data-emoji="${esc(r.emoji)}" title="${r.count} reaction${r.count!==1?'s':''}">${esc(r.emoji)} <span>${r.count}</span></button>`).join('')}<button type="button" class="discord-reaction-add" data-action="discord-emoji" data-id="${esc(m.id)}" title="Add another reaction">${icon('smile',15)}</button></div>`:''}`;
  const toolbar=m=>`<button type="button" data-action="discord-emoji" data-id="${esc(m.id)}" title="Add Reaction" aria-label="Add reaction">${icon('smile',17)}</button><button type="button" data-action="discord-reply" data-id="${esc(m.id)}" title="Reply" aria-label="Reply">${icon('message-square',17)}</button>${m.author_type==='user'&&m.author_id===getData().user?.id?`<button data-action="discord-edit" data-id="${esc(m.id)}" title="Edit Message">${icon('edit',17)}</button>`:''}<button type="button" data-action="discord-pin" data-id="${esc(m.id)}" title="${m.pinned?'Unpin':'Pin'} message">${icon('pin',17)}</button>`;
  const contextMenu=(m,menuItem,menuDivider)=>`${menuItem('Reply','discord-reply',{ico:'message-square',id:m.id})}${menuItem('Add Reaction','discord-emoji',{ico:'smile',id:m.id})}${menuItem(m.pinned?'Unpin Message':'Pin Message','discord-pin',{ico:'pin',id:m.id})}${menuDivider()}${m.author_type==='user'&&m.author_id===getData().user?.id?menuItem('Edit Message','discord-edit',{ico:'edit',id:m.id}):''}${menuItem('Copy Message Text','copy-message',{ico:'copy',id:m.id})}${menuItem('Copy Message Link','discord-copy-message-link',{ico:'link',id:m.id})}${menuItem('Copy Message ID','discord-copy-id',{ico:'copy',id:m.id})}`;
  const mentionsMe=m=>m.author_type!=='user'||m.author_id!==getData().user?.id?new RegExp(`<@${getData().user?.id}>|(^|\\s)@(everyone|here)\\b`,'i').test(m.content):false;
  const unreadBadge=(type,id)=>{const n=getData().unreads?.[`${type}:${id}`];return n?.mentions?`<span class="discord-unread-mentions" title="${n.mentions} mention${n.mentions!==1?'s':''}">${Math.min(n.mentions,99)}</span>`:n?.total?'<span class="discord-unread-dot" title="Unread messages"></span>':''};
  const pinnedButton=()=>`<button class="icon-btn discord-header-pin" data-action="discord-pins" title="Pinned Messages" aria-label="Pinned messages">${icon('pin',19)}</button>`;
  const composerActions=()=>`<div class="discord-format-row"><button type="button" data-action="discord-format" data-format="bold" title="Bold · Ctrl+B"><strong>B</strong></button><button type="button" data-action="discord-format" data-format="italic" title="Italic · Ctrl+I"><em>I</em></button><button type="button" data-action="discord-format" data-format="code" title="Code"><span>&lt;/&gt;</span></button><button type="button" data-action="discord-format" data-format="quote" title="Quote"><span>❞</span></button><span></span><button type="button" data-action="discord-commands" title="Slash Commands">/ Commands</button></div>`;
  const composerIcons=()=>`<button type="button" class="composer-tool" data-action="discord-mention" title="Mention people or agents">@</button><button type="button" class="composer-tool" data-action="discord-emoji" title="Emoji picker">${icon('smile',20)}</button>`;
  const emojiEntries=(q='')=>Object.entries(EMOJI_SECTIONS).map(([title,list])=>({title,list:list.filter(e=>!q||e.includes(q)||EMOJI_NAMES[e]?.includes(q.toLowerCase()))})).filter(s=>s.list.length);
  const el=()=>document.getElementById('message-input');
  function focusComposer(){const textarea=el();textarea?.focus();return textarea}
  function updateDraft(){const textarea=el();if(!textarea)return;state().drafts[key()]=textarea.value;textarea.style.height='auto';textarea.style.height=Math.min(textarea.scrollHeight,220)+'px'}
  function insert(text,{start,end}={}){const textarea=focusComposer();if(!textarea)return;
    const a=start??textarea.selectionStart,b=end??textarea.selectionEnd;textarea.setRangeText(text,a,b,'end');updateDraft();textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}
  const suggested=(type,query='')=>{
    const lower=query.trim().toLowerCase();
    if(type==='@'){
      const people=(getData().members||[]).map(m=>({name:m.display_name,sub:`@${m.username} · Team member`,insert:`<@${m.id}> `,kind:'user',id:m.id,avatar:m.avatar}));
      const bots=(getData().agents||[]).map(a=>({name:a.name,sub:`AI agent · ${a.type}`,insert:`<@${a.id}> `,kind:'agent',id:a.id,avatar:a.avatar}));
      const groups=isAdmin()?[{name:'everyone',sub:'Notify every team member',insert:'@everyone ',kind:'group',avatar:'📣'},{name:'here',sub:'Notify available team members',insert:'@here ',kind:'group',avatar:'🟢'}]:[];
      return [...groups,...people,...bots].filter(p=>!lower||p.name.toLowerCase().includes(lower)||p.sub.toLowerCase().includes(lower)).slice(0,9);
    }
    if(type==='#')return (getData().channels||[]).filter(c=>!lower||c.name.toLowerCase().includes(lower)).slice(0,8).map(c=>({name:'#'+c.name,sub:'Text channel',insert:`<#${c.id}> `,kind:'channel',avatar:'#',id:c.id}));
    if(type==='/')return SLASH.filter(c=>!lower||c.command.slice(1).includes(lower)).map(c=>({name:c.command,sub:c.help,insert:c.command+' ',kind:'command',avatar:'/'}));
    return [];
  };
  function suggestionsFrom(textarea){const caret=textarea.selectionStart,prefix=textarea.value.slice(0,caret);let m;
    if(/^\/[a-z0-9_-]{0,32}$/i.test(prefix)){m={type:'/',query:prefix.slice(1),start:0,end:caret}}
    else {const match=/(?:^|[\s([\{])([@#])([\w .-]{0,36})$/i.exec(prefix);if(match){m={type:match[1],query:match[2],start:caret-match[1].length-match[2].length,end:caret}}}
    if(!m)return null;const entries=suggested(m.type,m.query);return entries.length?{...m,entries,selected:0}:null;
  }
  const suggestionMarkup=()=>suggest?`<div class="discord-suggestions" role="listbox" aria-label="${suggest.type==='@'?'Mention someone':suggest.type==='#'?'Mention channel':'Choose a command'}"><div class="discord-suggest-title">${suggest.type==='@'?'MENTION PEOPLE & AGENTS':suggest.type==='#'?'CHANNELS':'AVAILABLE COMMANDS'} <span>↑↓ navigate · Tab to insert</span></div>${suggest.entries.map((entry,i)=>`<button type="button" role="option" aria-selected="${i===suggest.selected}" data-action="discord-suggestion" data-index="${i}" class="discord-suggest-option ${i===suggest.selected?'active':''}"><span class="discord-suggest-avatar ${entry.kind}">${esc(entry.avatar||entry.name.slice(0,1))}</span><span><strong>${esc(entry.name)}</strong><small>${esc(entry.sub)}</small></span>${i===suggest.selected?'<kbd>↵</kbd>':''}</button>`).join('')}</div>`:'';
  function updateSuggestions(){const textarea=el();if(!textarea||!textarea.isConnected||document.activeElement!==textarea){suggest=null;updatePopups();return}
    suggest=suggestionsFrom(textarea);updatePopups();}
  function selectSuggestion(index){if(!suggest)return;const entry=suggest.entries[index];if(!entry)return;const {start,end}=suggest;suggest=null;insert(entry.insert,{start,end});updateSuggestions();}
  const clickPosition=(button,width=360)=>{const rect=button?.getBoundingClientRect();return {x:Math.max(10,Math.min(window.innerWidth-width-10,rect?.left||window.innerWidth-420)),y:Math.max(42,Math.min(window.innerHeight-400,rect?.bottom||window.innerHeight-450))}};
  const emojiMarkup=()=>popup?.kind==='emoji'?`<div class="discord-emoji-popover" role="dialog" aria-label="Select an emoji" style="left:${popup.x}px;top:${popup.y}px"><header><span>Emoji</span><button type="button" data-action="discord-close-popup" aria-label="Close">×</button></header><input id="discord-emoji-filter" placeholder="Find the perfect reaction…" aria-label="Search emoji" autocomplete="off" value="${esc(popup.query||'')}"/><div class="discord-emoji-grid">${emojiEntries(popup.query).map(g=>`<div class="discord-emoji-section"><h4>${g.title}</h4><div>${g.list.map(e=>`<button type="button" data-action="discord-emoji-pick" data-emoji="${esc(e)}" title="${esc(e)}" aria-label="Choose ${esc(e)}">${e}</button>`).join('')}</div></div>`).join('')}</div></div>`:'';
  const plusMarkup=()=>popup?.kind==='plus'?`<div class="discord-quick-menu" style="left:${popup.x}px;top:${popup.y}px"><button type="button" data-action="discord-file-picker">＋ <span>Upload a file</span><small>Up to 8 MB</small></button><button type="button" data-action="discord-thread">☷ <span>Create a thread</span><small>Focused discussion</small></button><button type="button" data-action="discord-commands">/ <span>Use slash command</span><small>/thread /shrug /roll…</small></button></div>`:'';
  const popupRoot=()=>document.getElementById('discord-popup-root');
  function updatePopups(){const root=popupRoot();if(root)root.innerHTML=suggestionMarkup()+emojiMarkup()+plusMarkup();}
  function openEmoji(button,messageId=''){suggest=null;popup={kind:'emoji',messageId,...clickPosition(button,360),query:''};updatePopups();requestAnimationFrame(()=>document.getElementById('discord-emoji-filter')?.focus());}
  function openPlus(button){suggest=null;popup={kind:'plus',...clickPosition(button,270)};updatePopups()}
  const hidePopups=()=>{suggest=null;popup=null;updatePopups()};
  function afterRender(){
    let root=popupRoot();if(!root){root=document.createElement('div');root.id='discord-popup-root';root.className='discord-popup-root';document.querySelector('#app')?.appendChild(root)}
    updateHeader();updatePopups();if(pins)renderPins();linkifyVisibleMessages();
    let input=document.getElementById('discord-file-input');if(!input){input=document.createElement('input');input.id='discord-file-input';input.type='file';input.multiple=true;input.accept='.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv';input.style.display='none';input.setAttribute('aria-label','Attach files');document.querySelector('#app')?.appendChild(input)}
  }
  function linkifyVisibleMessages(){
    // Use DOM text nodes rather than regexing already-rendered HTML attributes.
    for(const area of document.querySelectorAll('.markdown')){
      const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);const nodes=[];
      while(walker.nextNode()){
        const node=walker.currentNode;if(!/https?:\/\//i.test(node.textContent||''))continue;
        if(node.parentElement.closest('a,button,code,pre,script,style'))continue;
        nodes.push(node);
      }
      for(const node of nodes){const text=node.textContent,parts=text.split(/(https?:\/\/[^\s<>]+)/gi);if(parts.length<2)continue;
        const fragment=document.createDocumentFragment();for(const piece of parts){
          if(/^https?:\/\//i.test(piece)){const cleaned=piece.replace(/[.,;!?)]+$/,'');
            try{const url=new URL(cleaned);if(['https:','http:'].includes(url.protocol)){const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.className='discord-external-link';a.textContent=cleaned;fragment.appendChild(a);if(piece!==cleaned)fragment.appendChild(document.createTextNode(piece.slice(cleaned.length)));continue}}catch{}
          }fragment.appendChild(document.createTextNode(piece));
        }node.parentNode.replaceChild(fragment,node);
      }
    }
  }
  function changingTarget(){hidePopups();pins=null;}
  const beforeSend=async(raw)=>{
    const text=String(raw||'').trim();const s=slot();
    if(s.uploads.some(f=>f.pending))throw new Error('Wait until your files finish uploading');
    if(text.startsWith('/')){
      const [command,...parts]=text.split(/\s+/);const arg=parts.join(' ').trim();
      if(command==='/help'){(onHelp||(()=>openModal('help')))();return{handled:true}}
      if(command==='/agent'){openModal('agent-directory');return{handled:true}}
      if(command==='/invite'){openModal('invite');return{handled:true}}
      if(command==='/thread'){const type=state().selected.type;const id=type==='thread'?(getData().threads||[]).find(t=>t.id===state().selected.id)?.channel_id:state().selected.id;if(!id||type==='dm'){toast('Threads can only be created in channels');return{handled:true}}openModal('create-thread',{channelId:id,name:arg});return{handled:true}}
      if(command==='/shrug')return{handled:false,body:{content:`${arg} ¯\\_(ツ)_/¯`.trim(),replyToId:s.reply?.id,attachmentIds:s.uploads.map(x=>x.id)}};
      if(command==='/me')return{handled:false,body:{content:`*${getData().user?.display_name||'Someone'} ${arg||'is here'}*`,replyToId:s.reply?.id,attachmentIds:s.uploads.map(x=>x.id)}};
      if(command==='/roll'){const n=Number(arg)||100;if(!Number.isInteger(n)||n<2||n>100000)throw new Error('Roll range must be between 2 and 100000');return{handled:false,body:{content:`🎲 Rolled ${Math.floor(Math.random()*n)+1} (1–${n})`,replyToId:s.reply?.id,attachmentIds:s.uploads.map(x=>x.id)}}}
      if(suggested('/',command.slice(1)).length)throw new Error(`Unknown command ${command}. Try /help.`);
    }
    if(!text&&!s.uploads.length) return {handled:true};
    return {handled:false,body:{content:text,replyToId:s.reply?.id||undefined,attachmentIds:s.uploads.map(x=>x.id)}};
  };
  function afterSend(){const s=slot();s.reply=null;s.uploads=[];suggest=null;updateHeader();updatePopups()}
  const reply=id=>{
    const m=state().messages.find(m=>m.id===id);if(!m)return;
    slot().reply=m;save();updateHeader();hidePopups();focusComposer();
  };
  async function edit(id){const m=state().messages.find(m=>m.id===id);if(!m||m.author_type!=='user'||m.author_id!==getData().user?.id)return;
    const message=document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);if(!message)return;
    const md=message.querySelector('.markdown');if(!md)return;
    md.innerHTML=`<div class="discord-edit-wrap"><textarea id="discord-edit-input" aria-label="Edit message">${esc(m.content)}</textarea><div class="discord-edit-bottom"><span>esc to <a data-action="discord-edit-cancel" data-id="${esc(id)}" href="#">cancel</a> · enter to save</span><button type="button" class="button-secondary" data-action="discord-edit-cancel" data-id="${esc(id)}">Cancel</button><button type="button" class="button-primary" data-action="discord-edit-save" data-id="${esc(id)}">Save</button></div></div>`;
    const input=document.getElementById('discord-edit-input');input.focus();input.selectionStart=input.selectionEnd=input.value.length;
  }
  async function refresh(){await loadMessages();renderMessagesOnly();}
  const copy=async(value)=>{try{await navigator.clipboard.writeText(value);toast('Copied to clipboard')}catch{toast('Clipboard is unavailable')}};
  const pinPanelNode=()=>document.getElementById('discord-pins-panel');
  function renderPins(){document.getElementById('discord-pins-panel')?.remove();if(!pins)return;
    const panel=document.createElement('aside');panel.id='discord-pins-panel';panel.className='discord-pins-panel';panel.innerHTML=`<header><div><strong>Pinned Messages</strong><small>Useful messages stay close</small></div><button type="button" data-action="discord-close-pins" title="Close pinned messages" aria-label="Close">×</button></header><section>${pins.loading?'<p class="discord-pin-empty">Loading pins…</p>':pins.messages.length?pins.messages.map(m=>`<button type="button" class="discord-pin-card" data-action="discord-jump-pin" data-id="${esc(m.id)}"><strong>${esc(nameOf(m))}</strong><small>${esc(new Date(m.created_at).toLocaleDateString())}</small><p>${esc(m.content.slice(0,240))}</p></button>`).join(''):'<div class="discord-pin-empty"><span>📌</span><b>No pinned messages yet</b><p>Pin a message from its right-click menu or toolbar.</p></div>'}</section>`;
    const host=document.querySelector('.chat-main');host?.appendChild(panel);
  }
  async function togglePins(){if(pins){pins=null;renderPins();return}
    const selected={...state().selected};pins={loading:true,messages:[]};renderPins();
    try{const x=await api(`/social/pins?type=${encodeURIComponent(selected.type)}&id=${encodeURIComponent(selected.id)}`);
      if(pins&&state().selected.type===selected.type&&state().selected.id===selected.id){pins={loading:false,messages:x.messages};renderPins()}
    }catch(e){pins=null;renderPins();throw e}
  }
  const jump=id=>{const msg=document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);if(!msg){toast('Message is outside the 150-message window. Use Search to find older messages.');return}
    msg.scrollIntoView({behavior:'smooth',block:'center'});msg.classList.add('discord-message-highlight');setTimeout(()=>msg.classList.remove('discord-message-highlight'),1700);
  };
  async function uploadFiles(files){const selected={...state().selected};const s=slot();for(const file of [...files].slice(0,5)){
    if(s.uploads.length>=5){toast('Maximum 5 attachments per message','error');break}
    if(file.size>8*1024*1024){toast(`${file.name}: maximum file size is 8 MB`,'error');continue}
    const temp={id:'pending-'+Date.now()+'-'+Math.random().toString(36).slice(2),filename:file.name,mime:file.type||'application/octet-stream',bytes:file.size,pending:true};s.uploads.push(temp);activeUpload++;updateHeader();
    try{
      const res=await fetch(`/api/social/uploads?type=${encodeURIComponent(selected.type)}&id=${encodeURIComponent(selected.id)}`,{method:'POST',credentials:'same-origin',headers:{'content-type':temp.mime,'x-file-name':encodeURIComponent(file.name)},body:file});
      const json=await res.json();if(!res.ok)throw new Error(json.error||`Upload failed (${res.status})`);
      const index=s.uploads.findIndex(f=>f.id===temp.id);if(index>=0)s.uploads[index]=json.file;
    }catch(e){s.uploads=s.uploads.filter(f=>f.id!==temp.id);toast(`${file.name}: ${e.message}`,'error')}finally{activeUpload--;updateHeader()}
  }}
  async function handleAction(action,button,event){const id=button.dataset.id;
    switch(action){
      case 'discord-reply':reply(id);return true;
      case 'discord-cancel-reply':slot().reply=null;updateHeader();return true;
      case 'discord-edit':await edit(id);return true;
      case 'discord-edit-cancel':await refresh();return true;
      case 'discord-edit-save':{
        const content=String(document.querySelector('#discord-edit-input')?.value||'').trim();if(!content)throw new Error('Message cannot be empty');
        await api(`/messages/${id}`,{method:'PATCH',body:{content}});await refresh();toast('Message edited');return true;
      }
      case 'discord-react':case 'discord-emoji':openEmoji(button,id||'');return true;
      case 'discord-emoji-pick':{
        if(popup?.messageId){await api('/social/reactions',{method:'POST',body:{messageId:popup.messageId,emoji:button.dataset.emoji}});await refresh()}
        else insert(button.dataset.emoji);
        hidePopups();return true;
      }
      case 'discord-reaction-toggle':await api('/social/reactions',{method:'POST',body:{messageId:id,emoji:button.dataset.emoji}});await refresh();return true;
      case 'discord-pin':{
        const message=state().messages.find(m=>m.id===id);await api('/social/pins',{method:'POST',body:{messageId:id,pinned:!message?.pinned}});
        await refresh();toast(message?.pinned?'Unpinned message':'Pinned message');return true;
      }
      case 'discord-pins':await togglePins();return true;
      case 'discord-close-pins':pins=null;renderPins();return true;
      case 'discord-jump-pin':pins=null;renderPins();jump(id);return true;
      case 'discord-jump-reply':jump(id);return true;
      case 'discord-spoiler':button.classList.toggle('revealed');return true;
      case 'discord-copy-message-link':await copy(`${location.origin}/?view=${encodeURIComponent(state().selected.type)}&id=${encodeURIComponent(state().selected.id)}&message=${encodeURIComponent(id)}`);return true;
      case 'discord-copy-id':await copy(id);return true;
      case 'discord-mention':insert('@');return true;
      case 'discord-commands':insert('/');return true;
      case 'discord-suggestion':selectSuggestion(Number(button.dataset.index));return true;
      case 'discord-plus':openPlus(button);return true;
      case 'discord-close-popup':hidePopups();focusComposer();return true;
      case 'discord-file-picker':hidePopups();document.getElementById('discord-file-input')?.click();return true;
      case 'discord-remove-file':{
        const s=slot(),upload=s.uploads.find(x=>x.id===id);s.uploads=s.uploads.filter(x=>x.id!==id);updateHeader();
        if(upload&&!upload.pending)await api(`/social/uploads/${id}`,{method:'DELETE'});return true;
      }
      case 'discord-thread':hidePopups();{
        const t=state().selected.type,tid=state().selected.id;
        const channelId=t==='thread'?(getData().threads||[]).find(x=>x.id===tid)?.channel_id:tid;
        if(t==='dm')toast('Threads belong inside channels');else openModal('create-thread',{channelId});
      }return true;
      case 'discord-format':{
        const field=el();if(!field)return true;const start=field.selectionStart,end=field.selectionEnd,selected=field.value.slice(start,end),kind=button.dataset.format;
        if(kind==='quote'){insert(`> ${selected||'quote'}`,{start,end})}
        else{const mark=kind==='bold'?'**':kind==='italic'?'*':'`';insert(mark+(selected||'text')+mark,{start,end})}
        return true;
      }
      default:return false;
    }
  }
  function start(){
    document.addEventListener('input',event=>{
      if(event.target.id==='message-input'){updateSuggestions();typingEvent();}
      if(event.target.id==='discord-emoji-filter'&&popup?.kind==='emoji'){popup.query=event.target.value;const current=event.target.selectionStart;updatePopups();const input=document.querySelector('#discord-emoji-filter');input?.focus();input?.setSelectionRange(current,current)}
    });
    document.addEventListener('change',event=>{if(event.target.id==='discord-file-input'){void uploadFiles(event.target.files);event.target.value=''}});
    document.addEventListener('paste',event=>{if(event.target.id==='message-input'&&event.clipboardData?.files?.length){event.preventDefault();void uploadFiles(event.clipboardData.files)}});
    document.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files')&&event.target.closest('.chat-main'))event.preventDefault()});
    document.addEventListener('drop',event=>{if(event.dataTransfer?.files?.length&&event.target.closest('.chat-main')){event.preventDefault();void uploadFiles(event.dataTransfer.files)}});
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&(suggest||popup||pins)){hidePopups();if(pins){pins=null;renderPins()}event.preventDefault();event.stopImmediatePropagation();return}
      const editBox=event.target.id==='discord-edit-input';if(editBox){
        if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();document.querySelector('[data-action="discord-edit-save"]')?.click()}
        return;
      }
      if(event.target.id!=='message-input')return;
      if(suggest&&['ArrowUp','ArrowDown','Enter','Tab'].includes(event.key)){
        event.preventDefault();event.stopImmediatePropagation();
        if(event.key==='ArrowUp')suggest.selected=(suggest.selected-1+suggest.entries.length)%suggest.entries.length;
        else if(event.key==='ArrowDown')suggest.selected=(suggest.selected+1)%suggest.entries.length;
        else selectSuggestion(suggest.selected);
        updatePopups();return;
      }
      if(event.key==='ArrowUp'&&event.target.value.trim()===''){
        const message=state().messages.filter(m=>m.author_type==='user'&&m.author_id===getData().user?.id).at(-1);
        if(message){event.preventDefault();void edit(message.id)}
      }
      if((event.ctrlKey||event.metaKey)&&['b','i'].includes(event.key.toLowerCase())){
        event.preventDefault();event.stopImmediatePropagation();const kind=event.key.toLowerCase()==='b'?'bold':'italic';
        handleAction('discord-format',{dataset:{format:kind}},event).catch(e=>toast(e.message,'error'));
      }
    },true);
    document.addEventListener('pointerdown',event=>{
      if((popup||suggest)&&!event.target.closest('#discord-popup-root,.composer-holder'))hidePopups();
    });
  }
  start();
  return {messageIntro,messageBottom,toolbar,contextMenu,enrichMarkdown,unreadBadge,mentionsMe,receiveTyping,typingMarkup,jumpToMessage:jump,pinnedButton,composerHeader,composerActions,composerIcons,afterRender,changingTarget,beforeSend,afterSend,handleAction,openEmoji,reply};
}
