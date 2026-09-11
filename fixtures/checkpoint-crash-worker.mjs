// Test-only worker: real storage/locks/ACP controller, synthetic provider and publisher.
// No ports, credentials or real Buzz/Google calls.
import { PassThrough } from 'node:stream';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime=process.env.PROBE_RUNTIME_UNDER_TEST || fileURLToPath(new URL('..',import.meta.url));
const {createAcpServer}=await import(pathToFileURL(join(runtime,'src/acp-server.js')));
const {SessionState}=await import(pathToFileURL(join(runtime,'src/session-state.js')));
const {DeliveryOutbox}=await import(pathToFileURL(join(runtime,'src/delivery/outbox.js')));
const [dir,mode,prior]=process.argv.slice(2);
const owner='ab'.repeat(32), channelId='123e4567-e89b-42d3-a456-426614174000';
const state=new SessionState({dir:join(dir,'state'),owner,relay:'wss://probe.invalid'});
const outbox=new DeliveryOutbox({dir:join(dir,'outbox'),owner});
const scope=await state.scope({channelId,cwd:dir,model:'gemini-3.8-flash-high'});
if(prior==='yes' && mode!=='resume') await state.save(scope,'confirmed-conversation');
const originalSave=state.save.bind(state), originalBegin=outbox.begin.bind(outbox), originalUpdate=outbox.update.bind(outbox);
const pause=async phase=>{ process.send({kind:'phase',phase});setInterval(()=>{},1000);await new Promise(()=>{}); };
if(mode==='before-publication')outbox.begin=async(...args)=>{await pause(mode);return originalBegin(...args);};
if(mode==='after-ack')outbox.update=async(...args)=>{await pause(mode);return originalUpdate(...args);};
if(mode==='after-sent')state.save=async(...args)=>{await pause(mode);return originalSave(...args);};
if(mode==='after-checkpoint')state.save=async(...args)=>{const value=await originalSave(...args);await pause(mode);return value;};
const output=new PassThrough();let wire='',trusted=null,providerCalls=0;
output.on('data',chunk=>{wire+=chunk;});
const server=createAcpServer({input:new PassThrough(),output,diagnostics:new PassThrough(),steeringSupported:false,
  modelCatalogFactory:async()=>[],identityFactory:async()=>owner,sessionStateFactory:()=>state,outboxFactory:()=>outbox,
  sessionFactory:()=>({setTrustedConversation(id){trusted=id;},prompt:async()=>{providerCalls++;return mode==='resume'?'NEW_INDEPENDENT':'FIRST_REPLY';},
    getConversationId:()=>trusted||'confirmed-conversation',hasConfirmedConversation:()=>true,
    retireForCheckpoint:async()=>trusted||'confirmed-conversation',close(){}}),
  publisherFactory:()=>({publish:async({content})=>{await appendFile(join(dir,'published.jsonl'),JSON.stringify({content})+'\n');return {status:'sent',eventId:'f'.repeat(64)};}})});
try {
  const call=(id,method,params)=>server.handle({jsonrpc:'2.0',id,method,params});
  await call(1,'initialize',{protocolVersion:1});await call(2,'session/new',{cwd:dir});
  await call(3,'session/prompt',{sessionId:[...server.sessions.keys()][0],prompt:[
    {type:'text',text:`<context>\nChannel: synthetic (#${channelId})\nThread root: ${'c'.repeat(64)}\n</context>`},
    {type:'text',text:mode==='resume'?'NEW_INDEPENDENT':'FIRST_REPLY'}]});
  process.send({kind:'result',rpc:wire.trim().split('\n').map(JSON.parse).find(r=>r.id===3),trusted,providerCalls,
    record:JSON.parse(await readFile(state.path(channelId),'utf8')),outbox:await outbox.list()});
} finally {await server.close();await state.release();process.disconnect();}
