// First-run onboarding + contextual help, independent of the Cord DOM rendering lifecycle.
const TOPICS=[
  {id:'start',icon:'✦',title:'Start here',description:'Cord is a shared workspace for people and agents.',body:'The left rail switches between your team and Direct Messages. Categories group channels. Each channel contains a timeline and focused threads. Your account and notifications live at the bottom-left.',action:'tour',actionTitle:'Take the tour'},
  {id:'channels',icon:'#',title:'Categories & channels',description:'Organize a product, department or client project.',body:'Create a category for each team or project. Add channels such as #general, #engineering and #decisions. A channel holds the broad conversation; use threads for individual tasks and discussions. Right-click a category or channel for management options.',action:'channel',actionTitle:'Create a channel'},
  {id:'threads',icon:'⌁',title:'Focused threads',description:'Keep related work and context together.',body:'Create a thread underneath a channel using its + button, or start one from an existing message. Threads are nested beneath their parent channel in the sidebar. Right-click a thread for Join, Lock, Close, Mute, and Edit Thread. Thread Settings control inactivity, slowmode and agent behavior.',action:'thread',actionTitle:'Create a thread'},
  {id:'agents',icon:'◇',title:'Connect an AI agent',description:'Pair Codex, Claude Code, Hermes, OpenClaw or OPAYA.',body:'Choose Connect Agent, copy the one-time setup prompt into the agent on its machine, then wait for it to pair. Each agent uses its own existing login or configured gateway. Assign it to a thread and choose Auto, Mentions, or Off; auto replies only react to human messages.',action:'agent',actionTitle:'Connect agent'},
  {id:'operator',icon:'✧',title:'Cord Operator — BYO LLM',description:'Use a model to manage Cord in plain language.',body:'Admins can connect an OpenAI, Claude, OpenRouter, Groq, Gemini or allowlisted compatible model. Ask Operator to find context, organize channels, create threads, assign agents or post a project update. The model cannot run arbitrary commands, access private DMs or read keys. Every change waits for your explicit approval.',action:'operator',actionTitle:'Open Operator'},
  {id:'mentions',icon:'@',title:'DMs and mentions',description:'Talk with people and agents.',body:'Open Direct Messages from the leftmost rail. A human or paired AI agent can be a participant. In channels, @mention a connected agent. In a thread, assign an agent and set its reply mode to Auto or Mentions. Agent replies cannot start an unlimited agent-to-agent loop.',action:'dm',actionTitle:'Open DMs'},
  {id:'security',icon:'♧',title:'Permissions and approvals',description:'Keep workspace administration under control.',body:'Only owners/admins can configure providers or agent connections. Worker tools may need approval in Agent Runs & Approvals. Operator changes always require approval, expire after fifteen minutes, and are logged; it does not execute shell commands or send private DMs.',action:'runs',actionTitle:'Agent runs'},
  {id:'shortcuts',icon:'⌘',title:'Shortcuts & workflow',description:'Move faster without leaving the keyboard.',body:'Ctrl/⌘+K opens search. Ctrl/⌘+, opens Settings. Ctrl/⌘+Shift+O opens Cord Operator (admins). F1 opens this Help Center. Enter sends a message, Shift+Enter inserts a line, and Escape closes a dialog. Right-click channels and threads to access their full tool menus.',action:'settings',actionTitle:'Settings'}
];
const TOUR=[
  {title:'One space for your people and AI',eyebrow:'WELCOME',subtitle:'Your conversations, work and agents belong together.',body:'Cord makes your team and AI agents part of the same conversation. Start with a channel, open a thread for focused work, then invite an agent to help.',icon:'✦',action:null},
  {title:'Channels organize the big picture',eyebrow:'YOUR WORKSPACE',subtitle:'Keep broad discussions easy to find.',body:'Use Categories and Channels for teams, clients or projects. Your team can chat in a channel and create dedicated threads beneath it. Nothing gets lost in a single endless chat.',icon:'#',action:'channel'},
  {title:'Threads keep the context',eyebrow:'THREAD-FIRST',subtitle:'Every topic gets its own home.',body:'Threads live visibly under their channel in the left sidebar. Edit, archive, lock, mute and join them with right-click. Agents can keep dedicated context within each thread.',icon:'⌁',action:'thread'},
  {title:'Bring the team together',eyebrow:'COLLABORATE',subtitle:'People, agents and shared knowledge.',body:'Invite people into your workspace. Message a teammate or agent privately via DMs. Use mentions for focused agent replies so channels stay readable.',icon:'◉',action:'invite'},
  {title:'Connect your existing agents',eyebrow:'AGENT CONNECTORS',subtitle:'OPAYA, Claude Code, Codex, Hermes and OpenClaw.',body:'Connect Agent generates a one-time pairing prompt. Paste it into your agent, then assign the connected agent to a thread. It will respond according to the thread mode, without uncontrolled agent-to-agent loops.',icon:'◇',action:'agent'},
  {title:'Let an LLM operate Cord',eyebrow:'CORD OPERATOR',subtitle:'Your model, your workspace, human approval.',body:'Workspace admins can bring an OpenAI-compatible or Claude API key. Ask the Operator to summarize a project, create threads, assign agents or post updates. All writes are proposed first and require explicit confirmation.',icon:'✧',action:'operator'}
];
const TOOLTIP_CONTENT={
  channels:'Channels hold broad conversations. Right-click for options; use + to create a thread.',
  threads:'Threads stay nested inside their channel. Right-click a thread for edit, close, lock and mute actions.',
  search:'Search messages across your team workspace (Ctrl/⌘+K).',
  agents:'Connect a real AI agent that can participate in channels, threads and DMs.',
  operator:'Ask a connected LLM to organize Cord. Every write requires approval.',
  members:'Your teammates and connected AI agents share the same workspace.',
  invite:'Invite a person using a single-use workspace link.',
  runs:'Review agent jobs, execution progress and pending tool approvals.',
  help:'First-time guide, reference articles and keyboard shortcuts (F1).'
};
const ANNOTATIONS=[
  ['.rail-help','help'],['.rail-new','agents'],['.rail-explore','invite'],
  ['.sidebar-scroll .quick-links [data-action="open-run-log"]','runs'],
  ['.sidebar-scroll .quick-links [data-action="open-agent-directory"]','agents'],
  ['.sidebar-scroll .quick-links [data-action="open-operator"]','operator'],
  ['.room-header .search-top','search'],['.channel-group .thread-row','threads'],
  ['.channel-panel .category-row','channels'],['.members-panel','members']
];
const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createGuidance({api,getData,isAdmin,onAction,onError}){
  let root=null,mode='tour',step=0,topic='start',query='',opened=false,scheduled=false,tip=null,tipEl=null;
  const userKey=()=>`cord:onboard:${getData()?.user?.id||'guest'}:v1`;
  const escape=htmlEscape;
  const button=(action,label,kind='')=>`<button type="button" class="guide-btn ${kind}" data-guide-action="${action}">${escape(label)}</button>`;
  function render(){
    if(!root)return;
    const item=TOUR[step];
    root.innerHTML=`<div class="guide-shade" data-guide-action="close"></div><section class="guide-window ${mode==='help'?'guide-help-window':''}" role="dialog" aria-label="Cord guidance" aria-modal="true">
      <header class="guide-header"><div class="guide-brand">C</div><div><strong>${mode==='tour'?'Welcome to Cord AI':'Cord Help Center'}</strong><small>${mode==='tour'?'Get productive in five minutes':'Answers where you need them'}</small></div><button data-guide-action="close" aria-label="Close guidance" class="guide-close">×</button></header>
      ${mode==='tour'?`<div class="guide-tour"><div class="guide-tour-left"><div class="guide-step-label">${escape(item.eyebrow)} · ${step+1}/${TOUR.length}</div><h2>${escape(item.title)}</h2><p class="guide-subtitle">${escape(item.subtitle)}</p><p class="guide-description">${escape(item.body)}</p><div class="guide-progress">${TOUR.map((_,index)=>`<button type="button" aria-label="Go to step ${index+1}" title="Step ${index+1}" class="${index===step?'active':index<step?'done':''}" data-guide-step="${index}"></button>`).join('')}</div>${item.action&&!(item.action==='operator'&&!isAdmin())?`<div class="guide-action-tip">${button('try-'+item.action,'Try it in Cord →','quiet')}</div>`:''}</div><div class="guide-tour-art"><div class="guide-sparkle guide-sparkle-one">✦</div><div class="guide-sparkle guide-sparkle-two">✧</div><div class="guide-art-icon">${item.icon}</div><strong>${['People + AI','Organize','Focus','Collaborate','Connect','Operate'][step]}</strong><span>Cord AI · One place for the whole team</span></div></div><footer class="guide-tour-footer">${button('skip','Skip for now','quiet')}<div class="guide-step-actions">${step?button('back','Back','secondary'):''}${button(step===TOUR.length-1?'finish':'next',step===TOUR.length-1?'Start working':'Continue →','primary')}</div></footer>`:
      `<div class="guide-help-body"><aside class="guide-topics"><div class="guide-help-heading">BROWSE TOPICS</div>${TOPICS.map(t=>`<button class="guide-topic ${topic===t.id?'active':''}" data-guide-topic="${t.id}"><span>${t.icon}</span>${escape(t.title)}</button>`).join('')}<div class="guide-topic-footer">${button('tour','Restart guided tour','quiet')}</div></aside><main class="guide-article"><div class="guide-help-search"><span>⌕</span><input id="guide-search" type="search" autocomplete="off" placeholder="Search help articles…" value="${escape(query)}"/></div>${query?`<div class="guide-help-results"><div class="guide-help-heading">SEARCH RESULTS</div>${TOPICS.filter(t=>(t.title+' '+t.description+' '+t.body).toLowerCase().includes(query.toLowerCase())).map(t=>`<button class="guide-result" data-guide-topic="${t.id}"><b>${escape(t.title)}</b><small>${escape(t.description)}</small></button>`).join('')||'<p>No matching articles. Try “agent”, “thread”, or “model”.</p>'}</div>`:
      `<div class="guide-article-symbol">${TOPICS.find(t=>t.id===topic)?.icon||'✦'}</div><div class="guide-help-heading">CORD AI GUIDES</div><h2>${escape(TOPICS.find(t=>t.id===topic)?.title||'Getting started')}</h2><p class="guide-subtitle">${escape(TOPICS.find(t=>t.id===topic)?.description||'')}</p><p class="guide-long-text">${escape(TOPICS.find(t=>t.id===topic)?.body||'')}</p><div class="guide-help-cta">${button('try-'+(TOPICS.find(t=>t.id===topic)?.action||'tour'),TOPICS.find(t=>t.id===topic)?.actionTitle||'Take a tour','primary')}${button('tour','Take full tour','secondary')}</div>`}</main></div>`}
      <div class="guide-footer-small">Made for teams, not gaming · Cord AI · F1 for help</div></section>`;
  }
  function open(next='help'){
    close();mode=next;query='';root=document.createElement('div');root.id='cord-guidance-root';document.body.append(root);
    root.addEventListener('click',handleClick);root.addEventListener('keydown',handleKeydown);root.addEventListener('input',handleInput);opened=true;render();
  }
  function close(){if(!root)return;root.remove();root=null;opened=false;}
  async function complete(){
    try{localStorage.setItem(userKey(),'1')}catch{}
    try{await api('/settings',{method:'PATCH',body:{onboardingComplete:true}})}catch(error){console.warn('Could not sync onboarding setting',error)}
    close();
  }
  function handleClick(event){
    const jump=event.target.closest('[data-guide-step]');if(jump){step=Number(jump.dataset.guideStep)||0;render();return}
    const chosen=event.target.closest('[data-guide-topic]');if(chosen){topic=chosen.dataset.guideTopic;query='';render();return}
    const btn=event.target.closest('[data-guide-action]');if(!btn)return;
    event.preventDefault();const action=btn.dataset.guideAction;
    if(action==='close'){close();return}
    if(action==='skip'||action==='finish'){void complete();return}
    if(action==='back'){step=Math.max(0,step-1);render();return}
    if(action==='next'){step=Math.min(TOUR.length-1,step+1);render();return}
    if(action==='tour'){step=0;mode='tour';render();return}
    if(action.startsWith('try-')){
      const target=action.slice(4);close();if(target==='tour'){open('tour');return}if(target==='operator'&&!isAdmin()){onError(new Error('Only admins can configure Cord Operator'));return}onAction(target);return;
    }
  }
  function handleInput(event){if(event.target.id==='guide-search'){query=event.target.value;const active=document.activeElement===event.target,pos=event.target.selectionStart;render();const box=root?.querySelector('#guide-search');if(active&&box){box.focus();box.setSelectionRange(pos,pos)}}}
  function handleKeydown(event){if(event.key==='Escape'){event.stopPropagation();close()}}
  function maybeStart(){
    if(opened||scheduled||!getData()?.user?.id)return;
    let done=false;try{done=localStorage.getItem(userKey())==='1'}catch{}
    if(done||getData()?.settings?.onboardingComplete)return;
    scheduled=true;setTimeout(()=>{scheduled=false;if(!root&&getData()?.user?.id&&!getData()?.settings?.onboardingComplete)open('tour')},500);
  }
  // Short on-hover descriptions augment existing titles and work with keyboard focus.
  function afterRender(){
    for(const [selector,key] of ANNOTATIONS){for(const el of document.querySelectorAll(selector)){el.setAttribute('data-guide-hint',key);}}
  }
  function renderTip(el,content){
    if(!el||opened)return;
    if(!tipEl){tipEl=document.createElement('div');tipEl.className='cord-guide-tooltip';tipEl.setAttribute('role','tooltip');document.body.append(tipEl)}
    tipEl.textContent=content;tipEl.hidden=false;
    const r=el.getBoundingClientRect();let left=Math.min(window.innerWidth-tipEl.offsetWidth-12,Math.max(12,r.left+r.width/2-tipEl.offsetWidth/2)),top=r.bottom+12;
    if(top+tipEl.offsetHeight>window.innerHeight-12)top=Math.max(12,r.top-tipEl.offsetHeight-12);
    tipEl.style.left=left+'px';tipEl.style.top=top+'px';tip=el;
  }
  const hideTip=()=>{if(tipEl)tipEl.hidden=true;tip=null};
  document.addEventListener('mouseover',event=>{const el=event.target.closest?.('[data-guide-hint]');if(!el||tip===el)return;hideTip();const content=TOOLTIP_CONTENT[el.dataset.guideHint];if(!content)return;renderTip(el,content)});
  document.addEventListener('mouseout',event=>{const el=event.target.closest?.('[data-guide-hint]');if(el&&(!event.relatedTarget||!el.contains(event.relatedTarget)))hideTip()});
  document.addEventListener('focusin',event=>{const el=event.target.closest?.('[data-guide-hint]');if(el)renderTip(el,TOOLTIP_CONTENT[el.dataset.guideHint])});
  document.addEventListener('focusout',hideTip);
  return {openHelp:()=>open('help'),openTour:()=>{step=0;open('tour')},close,maybeStart,afterRender,isOpen:()=>opened};
}
