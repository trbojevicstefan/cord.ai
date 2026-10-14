// A workspace-scoped, persistent inbox. No browser extension, service worker,
// polling dependency or external notification provider is required.
export function createNotificationsUI({api,icon,esc,getData,getSelected,selectTarget,jumpToMessage,renderOverlays,onError,toast}){
  let open=false,filter='all',items=[],cursor=null,loading=false,summary={unread:0,mentions:0,dms:0,agents:0};
  let workspaceId='',initial=true,request=0,latestEvent=null,refreshTimer=null;
  const filters=[['all','All'],['unread','Unread'],['mentions','Mentions'],['agents','Agents']];
  const labels={mention:'Mention',reply:'Reply',dm:'Direct message',thread:'Thread',channel:'Channel',agent_error:'Agent failed',agent_approval:'Approval needed'};
  const iconFor={mention:'at-sign',reply:'message-square',dm:'message-circle',thread:'threads',channel:'hash',agent_error:'alert-triangle',agent_approval:'shield-check'};
  const activeWorkspace=()=>getData().workspace?.id||workspaceId;
  const number=n=>n>99?'99+':String(n);
  const ago=stamp=>{
    const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(stamp))/1000));
    if(seconds<60)return 'now';if(seconds<3600)return `${Math.floor(seconds/60)}m`;
    if(seconds<86400)return `${Math.floor(seconds/3600)}h`;if(seconds<604800)return `${Math.floor(seconds/86400)}d`;
    return new Date(stamp).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  };
  const button=()=>`<button type="button" class="icon-btn cord-bell ${open?'cord-bell-open':''}" data-action="notification-toggle" aria-label="Notifications${summary.unread?' ('+summary.unread+' unread)':''}" aria-expanded="${open}" title="Notifications · Alt+N">${icon('bell',19)}${summary.unread?`<span class="cord-bell-count">${number(summary.unread)}</span>`:''}</button>`;
  const railButton=()=>`<button class="rail-help cord-bell-rail" data-action="notification-toggle" title="Notification inbox" aria-label="Open notification inbox">${icon('bell',19)}${summary.unread?`<span class="cord-rail-dot" aria-label="${summary.unread} unread"></span>`:''}</button>`;
  const itemHtml=item=>`<div class="cord-notification-row ${item.read_at?'read':'unread'}" role="listitem" data-notification-id="${esc(item.id)}">
    <button type="button" class="cord-notification-main" data-action="notification-open" data-id="${esc(item.id)}" title="Open conversation" aria-label="${esc(item.title)}">
      <span class="cord-notification-kind ${esc(item.kind)}">${icon(iconFor[item.kind]||'bell',18)}</span>
      <span class="cord-notification-copy"><span class="cord-notification-head"><strong>${esc(item.title)}</strong><time datetime="${esc(item.created_at)}">${esc(ago(item.created_at))}</time></span>
      <small>${esc(labels[item.kind]||'Notification')} · ${esc(item.target_type==='dm'?'DM':item.target_type)}</small><span class="cord-notification-preview">${esc(item.preview)}</span></span>
      ${!item.read_at?'<span class="cord-notification-unread" aria-label="Unread"></span>':''}
    </button><div class="cord-notification-actions"><button data-action="notification-read" data-id="${esc(item.id)}" title="${item.read_at?'Mark unread':'Mark read'}" aria-label="${item.read_at?'Mark unread':'Mark read'}">${icon('check',15)}</button><button data-action="notification-dismiss" data-id="${esc(item.id)}" title="Dismiss notification" aria-label="Dismiss notification">${icon('close',14)}</button></div>
  </div>`;
  function panel(){if(!open)return '';
    return `<div class="cord-notification-scrim" data-action="notification-close" aria-hidden="true"></div><section class="cord-notification-panel" role="dialog" aria-modal="false" aria-label="Notification inbox">
      <header class="cord-notification-top"><div class="cord-notification-title">${icon('bell',20)}<strong>Notifications</strong>${summary.unread?`<span class="cord-total-badge">${number(summary.unread)}</span>`:''}</div><button class="cord-notification-close" data-action="notification-close" aria-label="Close notifications">${icon('close',18)}</button></header>
      <nav class="cord-notification-filters" aria-label="Notification filters">${filters.map(([value,label])=>`<button type="button" class="${filter===value?'active':''}" data-action="notification-filter" data-filter="${value}" aria-pressed="${filter===value}">${label}${value==='mentions'&&summary.mentions?`<span>${number(summary.mentions)}</span>`:value==='agents'&&summary.agents?`<span>${number(summary.agents)}</span>`:''}</button>`).join('')}</nav>
      <div class="cord-notification-content" role="list" aria-label="Recent notifications">${loading&&!items.length?'<div class="cord-notification-loading">Loading…</div>':items.length?items.map(itemHtml).join(''):'<div class="cord-notification-empty"><span>✓</span><h3>All caught up</h3><p>Mentions, replies, DMs and agent alerts appear here.</p></div>'}${cursor?'<button type="button" class="cord-load-more" data-action="notification-more">Load older notifications</button>':''}</div>
      <footer class="cord-notification-footer"><button data-action="notification-read-all" ${!summary.unread?'disabled':''}>${icon('check',16)} Mark all read</button><button data-action="notification-settings">${icon('settings',16)} Settings</button></footer>
    </section>`;
  }
  function settings(){const s=getData().settings||{},row=(key,title,description)=>`<label class="cord-notification-setting"><span><strong>${esc(title)}</strong><small>${esc(description)}</small></span><input type="checkbox" name="${key}" ${s[key]!==false?'checked':''}/></label>`;
    return `<div class="settings-page-title">Notifications</div><form class="settings-section cord-notification-settings" data-form="notification-preferences">
      <h2>Desktop & sound</h2><p class="muted-paragraph">Cord saves notifications in your inbox. Desktop alerts appear only while Cord is open and your browser has granted permission.</p>
      <label class="cord-notification-setting"><span><strong>Desktop notifications</strong><small>Show system notifications when Cord isn't in focus.</small></span><input type="checkbox" name="desktopNotifications" ${s.desktopNotifications?'checked':''}/></label>
      <label class="cord-notification-setting"><span><strong>Notification sound</strong><small>Play a subtle alert for new, eligible notifications.</small></span><input type="checkbox" name="notificationSound" ${s.notificationSound?'checked':''}/></label>
      <button type="button" class="button-secondary" data-action="notification-permission">Enable browser notifications</button>
      <h2>Notify me about</h2>
      ${row('notifyDirectMessages','Direct messages','Messages from teammates and connected agents.')}
      ${row('notifyMentions','Mentions','Direct @mentions and authorized @here / @everyone.')}
      ${row('notifyReplies','Replies','When someone replies to a message you wrote.')}
      ${row('notifyThreadActivity','Followed threads','Activity in threads you joined or created.')}
      ${row('notifyChannelActivity','Subscribed channels','All messages in channels set to All notifications.')}
      ${row('notifyAgentEvents','Agent activity','Failed runs and actions waiting for approval.')}
      <h2>Quiet hours</h2><p class="muted-paragraph">Keep inbox history, but silence desktop alerts and sounds during these local hours. Leave both empty to disable.</p>
      <div class="cord-quiet-hours"><label>From <input type="time" name="quietHoursStart" value="${esc(s.quietHoursStart||'')}"></label><label>Until <input type="time" name="quietHoursEnd" value="${esc(s.quietHoursEnd||'')}"></label></div>
      <button type="submit" class="button-primary">Save notification preferences</button>
      <p class="muted-paragraph">For individual channels, threads or DMs, right-click → Notification Settings. Muted categories and conversations don't send alerts.</p>
    </form>`;
  }
  function quietNow(){const s=getData().settings||{};const from=s.quietHoursStart,to=s.quietHoursEnd;if(!from||!to||from===to)return false;const d=new Date(),hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');return from<to?hm>=from&&hm<to:hm>=from||hm<to}
  function sound(){try{const A=window.AudioContext||window.webkitAudioContext;if(!A)return;const ctx=new A(),osc=ctx.createOscillator(),vol=ctx.createGain();osc.type='sine';osc.frequency.setValueAtTime(740,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(560,ctx.currentTime+0.16);vol.gain.setValueAtTime(0.025,ctx.currentTime);vol.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.18);osc.connect(vol);vol.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+0.19);osc.onended=()=>ctx.close();}catch{}}
  async function load({append=false,focus=false}={}){
    if(loading)return;
    const ws=activeWorkspace();if(!ws)return;loading=true;const id=++request;if(!append)cursor=null;
    if(open)renderOverlays();
    try{const params=new URLSearchParams({workspaceId:ws,filter,limit:'25'});if(append&&cursor)params.set('before',cursor);
      const result=await api('/notifications?'+params);
      if(id!==request||ws!==activeWorkspace())return;
      summary=result.summary||summary;const existing=append?new Set(items.map(x=>x.id)):null;
      items=append?[...items,...result.items.filter(x=>!existing.has(x.id))]:result.items;
      cursor=result.nextCursor||null;
    }catch(e){onError(e)}finally{loading=false;if(open)renderOverlays()}
  }
  function sync(bootstrap){const ws=activeWorkspace();if(workspaceId!==ws){workspaceId=ws;items=[];cursor=null;initial=true;open=false}if(bootstrap){summary=bootstrap}if(!initial||!ws)return;initial=false;}
  async function refresh(){if(!activeWorkspace())return;try{
      const response=await api('/notifications/summary?workspaceId='+encodeURIComponent(activeWorkspace()));summary=response.summary;
      if(open)await load();else renderOverlays();
      updateBadges();
    }catch(e){onError(e)}}
  function updateBadges(){const bell=document.querySelector('.cord-bell');if(bell){const holder=document.createElement('span');holder.innerHTML=button();bell.replaceWith(holder.firstElementChild)}const rail=document.querySelector('.cord-bell-rail');if(rail){const holder=document.createElement('span');holder.innerHTML=railButton();rail.replaceWith(holder.firstElementChild)}}
  async function notifyDesktop(notification){
    if(!notification||quietNow()||notification.read_at)return;
    const s=getData().settings||{};const chosen=getSelected();
    const viewing=chosen?.type===notification.target_type&&chosen?.id===notification.target_id&&!document.hidden;
    if(viewing)return;
    if(s.notificationSound) sound();
    if(s.desktopNotifications&&'Notification' in window&&Notification.permission==='granted'&&document.hidden){
      try{const popup=new Notification(notification.title,{body:notification.preview.slice(0,160),icon:'/favicon.svg',tag:notification.id});popup.onclick=()=>{window.focus();openItem(notification).catch(onError);popup.close()}}catch{ /* Browser/OS denied notification */ }
    }
  }
  function onEvent(payload){if(!payload)return;summary=payload.summary||summary;updateBadges();
    if(payload.event==='created')latestEvent=payload.id;
    clearTimeout(refreshTimer);refreshTimer=setTimeout(async()=>{
      try{const pending=latestEvent;latestEvent=null;
        const was=items.find(x=>x.id===pending);
        if(open)await load();
        if(!was&&pending){const r=await api('/notifications?'+new URLSearchParams({workspaceId:activeWorkspace(),limit:'25'}));const n=r.items.find(x=>x.id===pending);if(n)await notifyDesktop(n);}
      }catch(e){onError(e)}
    },220);
  }
  async function openItem(item){
    await api('/notifications/'+encodeURIComponent(item.id),{method:'PATCH',body:{workspaceId:activeWorkspace(),read:true}});
    summary.unread=Math.max(0,summary.unread-Number(!item.read_at));open=false;items=[];renderOverlays();updateBadges();
    selectTarget(item.target_type,item.target_id);
    if(item.message_id)setTimeout(()=>jumpToMessage(item.message_id),200);
  }
  async function handleAction(action,button){
    if(!action.startsWith('notification-'))return false;
    try{
      const id=button.dataset.id;
      switch(action){
        case 'notification-toggle':open=!open;if(open)await load();renderOverlays();break;
        case 'notification-close':open=false;renderOverlays();break;
        case 'notification-filter':filter=button.dataset.filter||'all';items=[];await load();break;
        case 'notification-more':if(cursor)await load({append:true});break;
        case 'notification-settings':open=false;renderOverlays();return 'settings';
        case 'notification-permission':if(!('Notification' in window))toast('Your browser does not support desktop notifications');else {const status=await Notification.requestPermission();toast(status==='granted'?'Desktop notifications enabled':'Browser permission not granted')}break;
        case 'notification-open':{const item=items.find(x=>x.id===id);if(item)await openItem(item);break}
        case 'notification-read':{
          const item=items.find(x=>x.id===id);if(!item)break;
          await api('/notifications/'+encodeURIComponent(id),{method:'PATCH',body:{workspaceId:activeWorkspace(),read:!item.read_at}});
          await load();break;
        }
        case 'notification-dismiss':await api('/notifications/'+encodeURIComponent(id),{method:'DELETE',body:{workspaceId:activeWorkspace()}});await load();break;
        case 'notification-read-all':await api('/notifications/read-all',{method:'POST',body:{workspaceId:activeWorkspace()}});await load();break;
        default:return false;
      }
    }catch(e){onError(e)}
    return true;
  }
  async function save(values){const flags=['desktopNotifications','notificationSound','notifyDirectMessages','notifyMentions','notifyReplies','notifyThreadActivity','notifyChannelActivity','notifyAgentEvents'];const body=Object.fromEntries(flags.map(k=>[k,!!values[k]]));body.quietHoursStart=values.quietHoursStart||'';body.quietHoursEnd=values.quietHoursEnd||'';return api('/settings',{method:'PATCH',body})}
  function close(){if(!open)return false;open=false;renderOverlays();return true}
  return {button,railButton,panel,settings,sync,onEvent,handleAction,save,close,refresh,updateBadges};
}
