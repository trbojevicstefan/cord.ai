import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { isIP } from 'node:net';

function key(){
  const secretKey=process.env.CORD_MASTER_KEY;
  if(!secretKey || !/^[0-9a-fA-F]{64}$/.test(secretKey)) throw Object.assign(new Error('Set CORD_MASTER_KEY to 64 hex digits before saving an API key.'),{status:400});
  return Buffer.from(secretKey,'hex');
}
export function encryptSecret(secret){
  if(!secret) return '';
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key(),iv);
  const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),encrypted.toString('hex')].join(':');
}
export function decryptSecret(value){
  if(!value)return '';
  const [iv,tag,data]=value.split(':');
  const cipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'hex'));
  cipher.setAuthTag(Buffer.from(tag,'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data,'hex')),cipher.final()]).toString('utf8');
}
export function assertEndpoint(endpoint){
  let url;try{url=new URL(endpoint)}catch{throw Object.assign(new Error('Invalid agent connector URL'),{status:400})}
  if(url.username||url.password||url.hash)throw Object.assign(new Error('Connector URL must not contain credentials or a fragment'),{status:400});
  const dev=process.env.CORD_DEMO!=='0' && process.env.NODE_ENV!=='production';
  const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:' && !(dev && url.protocol==='http:' && loopback)) throw Object.assign(new Error('HTTPS is required for remote connectors.'),{status:400});
  const allowed=(process.env.CORD_AGENT_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if((process.env.NODE_ENV==='production'||process.env.CORD_DEMO==='0')&&!allowed.length)throw Object.assign(new Error('CORD_AGENT_ALLOWED_HOSTS must be set before connecting remote agents.'),{status:400});
  if(allowed.length && !allowed.includes(url.hostname.toLowerCase()) && !(dev&&loopback))throw Object.assign(new Error('Endpoint host is not in CORD_AGENT_ALLOWED_HOSTS.'),{status:400});
  if(isIP(url.hostname) && !loopback && !allowed.includes(url.hostname.toLowerCase())) throw Object.assign(new Error('Direct IP endpoints must be explicitly allowlisted.'),{status:400});
  return url;
}

export async function invokeAgent(agent, history, { signal }={}) {
  const latest=history.at(-1)?.content||'';
  if(agent.type==='demo') {
    await new Promise((resolve,reject)=>{const t=setTimeout(resolve,600);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('Cancelled'))},{once:true});});
    const question=latest.replace(/@\S+/g,'').trim();
    if(/data|database|SQL|283 tables|BE\b/i.test(question)) return `**Demo response — no live database connected.**\n\nI can help frame your question, but Cord does not currently have access to BE or any private system. Connect **RWE Design** to your own approved model and read-only tools through an agent connector before requesting actual records.\n\nYour question: “${question.slice(0,240)}”`;
    if(/thread|channel|discord|cord/i.test(question))return `**Here's how I'd organize this:**\n\n• Keep the broad discussion in the channel.\n• Open a focused thread for each deliverable.\n• Assign an agent to the thread and set its reply mode to **Auto** or **Mentions only**.\n• Capture decisions here so everyone has the same context.\n\n*Demo agent — connect a real endpoint for autonomous reasoning.*`;
    return `I received your message in this conversation. In a real workspace I would use the assigned tools and the context from this thread to help the team.\n\n**Next step:** Connect this agent to an OpenAI-compatible endpoint or your OPAYA bridge in **Agents → Connect Agent**.\n\n*This is a simulated response, not a live model output.*`;
  }
  const endpoint=assertEndpoint(agent.endpoint);
  const secret=decryptSecret(agent.secret_encrypted);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),45000);
  if(signal)signal.addEventListener('abort',()=>controller.abort(),{once:true});
  try {
    if(agent.type==='openai') {
      const url=new URL(endpoint.href.replace(/\/$/,'')+'/chat/completions');
      const messages=[{role:'system',content:'You are a teammate and AI agent in Cord AI. Answer concisely and clearly. You have no tools or private database access unless the connector implementation explicitly grants them. Never claim you executed external actions.'}, ...history.slice(-24).map(m=>({role:m.author_type==='agent'?'assistant':'user',content:m.content}))];
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(secret?{authorization:`Bearer ${secret}`}:{})},body:JSON.stringify({model:agent.model||'gpt-4.1-mini',messages,stream:false}),signal:controller.signal,redirect:'error'});
      if(!response.ok)throw new Error(`Agent API returned HTTP ${response.status}`);
      const data=await response.json();const text=data?.choices?.[0]?.message?.content;
      if(typeof text!=='string'||!text.trim())throw new Error('Agent returned no text');
      return text.slice(0,24000);
    }
    if(agent.type==='opaya'||agent.type==='webhook') {
      const payload=JSON.stringify({version:'cord-bridge/1',agentId:agent.external_id||agent.id,threadId:history.at(-1)?.target_id,sessionId:history.at(-1)?.target_id,messages:history.slice(-20).map(m=>({id:m.id,role:m.author_type==='agent'?'assistant':'user',content:m.content})),message:latest});
      const signature=secret?createHmac('sha256',secret).update(payload).digest('hex'):'';
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(signature?{'x-cord-signature':`sha256=${signature}`}:{})},body:payload,signal:controller.signal,redirect:'error'});
      if(!response.ok)throw new Error(`Agent bridge returned HTTP ${response.status}`);
      const data=await response.json();
      if(typeof data?.reply!=='string'||!data.reply.trim())throw new Error('Bridge response missing reply string');
      return data.reply.slice(0,24000);
    }
    throw new Error('Unsupported connector type');
  } finally {clearTimeout(timer)}
}
