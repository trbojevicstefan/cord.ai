import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (!stored?.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const digest = scryptSync(password, salt, 64);
  const old = Buffer.from(expected, 'hex');
  return digest.length === old.length && timingSafeEqual(digest, old);
}

export function createDatabase(path, options = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar TEXT DEFAULT '', color TEXT DEFAULT '#5865f2',
      status TEXT DEFAULT 'online', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER DEFAULT 0, muted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL, description TEXT DEFAULT '', position INTEGER DEFAULT 0,
      muted INTEGER DEFAULT 0, notification_level TEXT DEFAULT 'all', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, avatar TEXT DEFAULT '', color TEXT DEFAULT '#ef6c5e', description TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'demo', status TEXT DEFAULT 'online',
      endpoint TEXT DEFAULT '', model TEXT DEFAULT '', external_id TEXT DEFAULT '',
      secret_encrypted TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived INTEGER DEFAULT 0, locked INTEGER DEFAULT 0, spoiler INTEGER DEFAULT 0,
      slowmode INTEGER DEFAULT 0, auto_hide_days INTEGER DEFAULT 3,
      muted INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      agent_mode TEXT DEFAULT 'auto', notification_level TEXT DEFAULT 'all'
    );
    CREATE TABLE IF NOT EXISTS thread_members (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(thread_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS dms (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      participant_user_id TEXT REFERENCES users(id), participant_agent_id TEXT REFERENCES agents(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('channel','thread','dm')),
      target_id TEXT NOT NULL, author_type TEXT NOT NULL CHECK(author_type IN ('user','agent','system')),
      author_id TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_target_time ON messages(target_type,target_id,created_at);
    CREATE INDEX IF NOT EXISTS threads_by_channel ON threads(channel_id,updated_at);
    CREATE TABLE IF NOT EXISTS preferences (
      user_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      muted INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, notification_level TEXT DEFAULT 'all',
      PRIMARY KEY(user_id,target_type,target_id)
    );
    CREATE TABLE IF NOT EXISTS reads (
      user_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      last_read_at TEXT NOT NULL, PRIMARY KEY(user_id,target_type,target_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT, UNIQUE(agent_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, action TEXT NOT NULL,
      target_type TEXT, target_id TEXT, meta TEXT DEFAULT '{}', created_at TEXT NOT NULL
    );
  `);
  // Upgrade the initial one-agent-per-message constraint without losing run history.
  if(/message_id TEXT NOT NULL UNIQUE/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='runs'").get().sql)){
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE runs_new (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, target_type TEXT NOT NULL,target_id TEXT NOT NULL,status TEXT NOT NULL,error TEXT DEFAULT '',created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(agent_id,message_id));
      INSERT INTO runs_new SELECT * FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
  const get = (sql,...params) => db.prepare(sql).get(...params);
  const all = (sql,...params) => db.prepare(sql).all(...params);
  const run = (sql,...params) => db.prepare(sql).run(...params);
  if(options.demo !== false && !get('SELECT id FROM workspaces LIMIT 1')) seedDemo({get, all, run});
  return { db, get, all, run, close:()=>db.close() };
}

function seedDemo({run,get}) {
  const date = now(), ws='ws-cord', stefan='user-stefan', christina='user-christina', rob='user-rob';
  for(const [id,username,name,color,avatar] of [
    [stefan,'stefan','Stefan Trbojevic','#5765ef','ST'],
    [christina,'christina','Christina P','#e85da9','CP'],
    [rob,'rob','robITS','#f0ac37','RB']
  ]) run('INSERT INTO users(id,username,display_name,password_hash,avatar,color,created_at) VALUES(?,?,?,?,?,?,?)',id,username,name,hashPassword('demo1234'),avatar,color,date);
  run('INSERT INTO workspaces(id,name,icon,created_at) VALUES(?,?,?,?)',ws,'Cord AI Team','C',date);
  for(const [id,role] of [[stefan,'owner'],[christina,'admin'],[rob,'member']])run('INSERT INTO memberships VALUES(?,?,?)',ws,id,role);
  for(const [id,name,position] of [['cat-team','TEXT CHANNELS',0],['cat-projects','PROJECTS',1]])run('INSERT INTO categories(id,workspace_id,name,position) VALUES(?,?,?,?)',id,ws,name,position);
  const channels=[['channel-general','cat-team','general','Team conversations',0],['channel-chat','cat-team','chat-channel','Talk to agents and your team',1],['channel-agent','cat-team','agent-training','Agent research and experiments',2],['channel-build','cat-projects','building-cord','Product development',3],['channel-integrations','cat-projects','agent-integrations','Configure external agents',4]];
  for(const [id,cat,name,desc,pos] of channels)run('INSERT INTO channels(id,workspace_id,category_id,name,description,position,created_at) VALUES(?,?,?,?,?,?,?)',id,ws,cat,name,desc,pos,date);
  const agents=[['agent-rwe','RWE Design','R',' #f96a56','Company knowledge agent. Demo mode until a real connector is configured.'],['agent-opaya','OPAYA Runner','O','#73a7e6','Connect OPAYA runtimes through the Cord bridge.'],['agent-research','Research Agent','R','#8b7cee','Research, summarize and analyze team conversations.']];
  for(const [id,name,avatar,rawColor,desc] of agents)run('INSERT INTO agents(id,workspace_id,name,avatar,color,description,created_at) VALUES(?,?,?,?,?,?,?)',id,ws,name,avatar,rawColor.trim(),desc,date);
  const threads=[
    ['thread-be','channel-chat','BE database access — testing thread (ask me anything)','agent-rwe','auto'],
    ['thread-question','channel-chat','I have a quick question. Would this work?','agent-rwe','mentions'],
    ['thread-connect','channel-chat','Connectivity test received — taking notes','agent-rwe','auto'],
    ['thread-social','channel-chat','Social Accounts Setup','agent-rwe','mentions'],
    ['thread-webhook','channel-chat','Coordinate Webhook data from Rob','agent-rwe','mentions'],
    ['thread-roadmap','channel-build','Cord MVP — build roadmap','agent-opaya','mentions'],
    ['thread-bridge','channel-integrations','OPAYA bridge architecture','agent-opaya','mentions']
  ];
  for(const [id,channel,name,agent,mode] of threads){
    run('INSERT INTO threads(id,workspace_id,channel_id,author_id,name,created_at,updated_at,agent_id,agent_mode) VALUES(?,?,?,?,?,?,?,?,?)',id,ws,channel,stefan,name,date,date,agent,mode);
    run('INSERT INTO thread_members(thread_id,user_id) VALUES(?,?)',id,stefan);
  }
  const message=(targetType,targetId,authorType,authorId,content,meta={})=>run('INSERT INTO messages(id,workspace_id,target_type,target_id,author_type,author_id,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(),ws,targetType,targetId,authorType,authorId,content,JSON.stringify(meta),date);
  message('thread','thread-be','agent','agent-rwe',`**BE database — testing thread.**\n\nAsk me anything about RWE's data in here and I'll query the live read-only copy of the BE database **once you connect a real data tool**. This Cord preview uses simulated data and does not access any company database.\n\n**Works with a connected source:**\n• Which projects entered a given phase, and when\n• What's active by type of client, work or market\n• Schedules and milestone dates per project\n• Files and photos attached to a project\n• Counts and trends\n\n**Ground rules:** Read-only access, no data dumps, and human approval for sensitive actions.`,{intro:true});
  message('thread','thread-roadmap','user',stefan,'Build the Discord-like collaboration experience with nested threads, contextual menus, member profiles, and shared AI agents.');
  message('thread','thread-bridge','agent','agent-opaya','**Integration target:** Cord is the collaboration surface. OPAYA remains the local-first agent runtime. A separately deployed authenticated bridge will translate Cord thread events to OPAYA sessions. This demo does not claim an active OPAYA session.');
  message('channel','channel-chat','agent','agent-rwe',`I now have a dedicated **BE database testing thread**. Please ask questions in there so we can keep the context together.`,{thread_ref:'thread-be'});
  message('channel','channel-chat','user',christina,'@RWE Design answering your question: I will coordinate the team contacts.');
  message('channel','channel-chat','agent','agent-rwe',`Both points noted. I'll keep the conversation here, and we can move detailed questions into a thread.`,{thread_ref:'thread-question'});
  message('channel','channel-general','user',stefan,`Welcome to **Cord AI**. Channels for the team, nested threads for focused work, and AI agents as first-class members. ✨`);
  message('channel','channel-build','user',stefan,'MVP priorities: pixel-close Discord layout, complete thread interaction, real-time team messages, and pluggable agent adapters.',{thread_ref:'thread-roadmap'});
  run('INSERT INTO dms(id,workspace_id,user_id,participant_agent_id,created_at) VALUES(?,?,?,?,?)','dm-rwe',ws,stefan,'agent-rwe',date);
  run('INSERT INTO dms(id,workspace_id,user_id,participant_agent_id,created_at) VALUES(?,?,?,?,?)','dm-opaya',ws,stefan,'agent-opaya',date);
  message('dm','dm-rwe','agent','agent-rwe',`Hey Stefan — I'm **RWE Design**. This is a demo session. You can talk to me here or in a thread. Connect an OpenAI-compatible endpoint or OPAYA bridge to use a real agent.`);
  message('dm','dm-opaya','agent','agent-opaya','Hi! OPAYA agents can join team conversations through the Cord bridge contract. Open **Connect Agent** to configure your gateway.');
}
