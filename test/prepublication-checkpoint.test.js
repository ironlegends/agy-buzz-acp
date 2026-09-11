import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionState } from '../src/session-state.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';
const owner='ab'.repeat(32), channelId='123e4567-e89b-42d3-a456-426614174000';
const prompt=[{type:'text',text:`<context>\nChannel: synthetic (#${channelId})\nThread root: ${'c'.repeat(64)}\n</context>`},{type:'text',text:'Synthetic independent request'}];
async function harness(t,{failStage=false, failRetire=false, failSave=false, initial=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'agy-prepublish-'));
  const state=new SessionState({dir:join(dir,'state'),owner,relay:'wss://probe.invalid'});
  const outbox=new DeliveryOutbox({dir:join(dir,'outbox'),owner});
  const scope=await state.scope({channelId,cwd:dir,model:'gemini-3.8-flash-high'});
  if(initial) await state.save(scope,'confirmed-conversation');
  if(failStage) state.stageCheckpoint=async()=>{throw new Error('synthetic disk failure');};
  if(failSave) state.save=async()=>{throw new Error('synthetic checkpoint failure');};
  const record=async()=>JSON.parse(await readFile(state.path(channelId),'utf8'));
  const calls={publications:0,retired:false};
  const output=new PassThrough();let wire='';output.on('data',c=>{wire+=c;});
  const server=createAcpServer({input:new PassThrough(),output,diagnostics:new PassThrough(),...isolatedServerOptions({
    sessionStateFactory:()=>state,outboxFactory:()=>outbox,identityFactory:async()=>owner,
    sessionFactory:()=>({setTrustedConversation(){},prompt:async()=> 'synthetic answer',getConversationId:()=> 'confirmed-conversation',hasConfirmedConversation:()=>true,
      retireForCheckpoint:async()=>{if(failRetire)throw new Error('synthetic unclosed provider');calls.retired=true;return 'confirmed-conversation';},close(){}}),
    publisherFactory:()=>({publish:async()=>{
      calls.publications++;
      assert.equal(calls.retired,true,'retirement precedes publication');
      const saved=await record();assert.equal(saved.status,'blocked');assert.equal(saved.conversationId,'confirmed-conversation');
      return {status:'sent',eventId:'d'.repeat(64)};
    }})})});
  t.after(async()=>{await server.close();await state.release();await rm(dir,{recursive:true,force:true});});
  await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1}});
  await server.handle({jsonrpc:'2.0',id:2,method:'session/new',params:{cwd:dir}});
  await server.handle({jsonrpc:'2.0',id:3,method:'session/prompt',params:{sessionId:[...server.sessions.keys()][0],prompt}});
  return {calls,state,outbox,scope,record,result:wire.trim().split('\n').map(JSON.parse).find(r=>r.id===3)};
}
for(const initial of [false,true]) test(`publication always has a blocked staged association (existing=${initial})`,async t=>{
  const h=await harness(t,{initial});assert.equal(h.result.result?.publication.status,'sent');assert.equal((await h.record()).status,'ready');
});
for(const failure of ['failStage','failRetire']) test(`${failure} prevents publication`,async t=>{
  const h=await harness(t,{[failure]:true});assert.ok(h.result.error);assert.equal(h.calls.publications,0);assert.equal((await h.outbox.list()).length,0);assert.equal((await h.record()).status,'blocked');
});
for(const initial of [false,true]) test(`publication followed by checkpoint failure keeps exact association (existing=${initial})`,async t=>{
  const h=await harness(t,{initial,failSave:true});
  assert.equal(h.result.result?.publication.status,'sent');assert.equal((await h.record()).conversationId,'confirmed-conversation');assert.equal((await h.record()).status,'blocked');
  assert.equal((await h.outbox.list())[0].status,'sent');
});

for(const invalid of ['ready','foreign','corrupt','missing']) test(`stageCheckpoint refuses ${invalid} without changing the record`,async t=>{
  const {writeFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'agy-stage-refusal-'));
  const state=new SessionState({dir,owner,relay:'wss://probe.invalid'});
  t.after(async()=>{await state.release();await rm(dir,{recursive:true,force:true});});
  const scope=await state.scope({channelId,cwd:dir,model:'gemini-3.8-flash-high'});
  if(invalid!=='missing') await state.save(scope,'original-conversation');
  if(invalid==='foreign'){
    await state.invalidate(scope);const saved=JSON.parse(await readFile(state.path(channelId),'utf8'));
    saved.scope.model='foreign-model';await writeFile(state.path(channelId),JSON.stringify(saved));
  }
  if(invalid==='corrupt')await writeFile(state.path(channelId),'invalid-json');
  const before=await readFile(state.path(channelId),'utf8').catch(()=>null);
  await assert.rejects(state.stageCheckpoint(scope,'new-confirmed-conversation'));
  assert.equal(await readFile(state.path(channelId),'utf8').catch(()=>null),before);
});
