import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionState } from '../src/session-state.js';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';
const owner='ab'.repeat(32), channel='11111111-1111-4111-8111-111111111111', relay='wss://test.invalid';
for(const previouslyOwned of [false,true]) test(`failed preflight releases only newly acquired unused ownership (${previouslyOwned})`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'agy-preflight-lease-'));
  const state=new SessionState({dir,owner,relay}), peer=new SessionState({dir,owner,relay});
  await writeFile(state.path(channel),'{corrupt');
  if(previouslyOwned) await state.ensureOwnership(channel);
  let calls=0,wire='';const output=new PassThrough();output.on('data',v=>{wire+=v;});
  const server=createAcpServer({input:new PassThrough(),output,diagnostics:new PassThrough(),
    ...isolatedServerOptions({sessionStateFactory:()=>state,identityFactory:async()=>owner,
      sessionFactory:()=>({prompt:async()=>{calls++;return 'unexpected';},close(){}})})});
  const rpc=(id,method,params)=>server.handle({jsonrpc:'2.0',id,method,params});
  try {
    await rpc(1,'initialize',{protocolVersion:1});await rpc(2,'session/new',{cwd:dir});
    await rpc(3,'session/prompt',{sessionId:[...server.sessions.keys()][0],prompt:[
      {type:'text',text:`<context>\nChannel: test (#${channel})\nThread root: ${'f'.repeat(64)}\n</context>`},{type:'text',text:'synthetic'}]});
    assert.ok(wire.trim().split('\n').map(JSON.parse).find(v=>v.id===3).error);
    assert.equal(calls,0);assert.equal(await readFile(state.path(channel),'utf8'),'{corrupt');
    if(previouslyOwned) await assert.rejects(peer.ensureOwnership(channel),e=>e.code==='AGY_SESSION_STATE_BUSY');
    else assert.equal(await peer.ensureOwnership(channel),true,'a second owner can inspect without terminating the first adapter');
  } finally {await server.close();await state.release();await peer.release();await rm(dir,{recursive:true,force:true});}
});

test('blocked bridge preflight releases unused ownership without archiving the bridge',async()=>{
  const {createHash}=await import('node:crypto');
  const {createSteeringCoordinator}=await import('../src/steering.js');
  const dir=await mkdtemp(join(tmpdir(),'agy-bridge-preflight-'));
  const state=new SessionState({dir:join(dir,'state'),owner,relay}),peer=new SessionState({dir:join(dir,'state'),owner,relay});
  const rootDir=join(dir,'steering');
  const bridgeDir=join(rootDir,`channel-${createHash('sha256').update(`${owner}:${channel}`).digest('hex')}`);
  const coordinator=await createSteeringCoordinator({rootDir,bridgeDir,ownerId:owner,channelId:channel,sessionId:'synthetic',conversationId:'synthetic-conversation',hookConfigured:true,injectorExclusive:true});
  await coordinator.block('synthetic blocked bridge');const before=await readFile(join(bridgeDir,'state.json'),'utf8');
  let calls=0,wire='';const output=new PassThrough();output.on('data',v=>{wire+=v;});
  const server=createAcpServer({input:new PassThrough(),output,diagnostics:new PassThrough(),...isolatedServerOptions({
    sessionStateFactory:()=>state,identityFactory:async()=>owner,sessionFactory:()=>({prompt:async()=>{calls++;},close(){}})}),
    steeringSupported:true,steeringConfig:{rootDir,ownerId:owner,hookConfigured:true,injectorExclusive:true}});
  const rpc=(id,method,params)=>server.handle({jsonrpc:'2.0',id,method,params});
  try{
    await rpc(1,'initialize',{protocolVersion:1});await rpc(2,'session/new',{cwd:dir});
    await rpc(3,'session/prompt',{sessionId:[...server.sessions.keys()][0],prompt:[{type:'text',text:`<context>\nChannel: test (#${channel})\nThread root: ${'f'.repeat(64)}\n</context>`},{type:'text',text:'synthetic'}]});
    assert.ok(wire.trim().split('\n').map(JSON.parse).find(v=>v.id===3).error);assert.equal(calls,0);
    assert.equal(await readFile(join(bridgeDir,'state.json'),'utf8'),before);
    assert.equal(state.ownsChannel(channel),false);assert.equal(await peer.ensureOwnership(channel),true);
  }finally{await server.close();await state.release();await peer.release();await rm(dir,{recursive:true,force:true});}
});
test('the active reservation remains held until unused ownership release settles',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agy-preflight-release-race-'));
  const state=new SessionState({dir,owner,relay});await writeFile(state.path(channel),'{corrupt');
  let entered,finish;const reached=new Promise(r=>{entered=r;});const gate=new Promise(r=>{finish=r;});
  const release=state.releaseOwnership.bind(state);state.releaseOwnership=async id=>{entered();await gate;return release(id);};
  let wire='';const output=new PassThrough();output.on('data',v=>{wire+=v;});
  const server=createAcpServer({input:new PassThrough(),output,diagnostics:new PassThrough(),...isolatedServerOptions({sessionStateFactory:()=>state,identityFactory:async()=>owner})});
  const rpc=(id,method,params)=>server.handle({jsonrpc:'2.0',id,method,params});
  try{
    await rpc(1,'initialize',{protocolVersion:1});await rpc(2,'session/new',{cwd:dir});
    const params={sessionId:[...server.sessions.keys()][0],prompt:[{type:'text',text:`<context>\nChannel: test (#${channel})\nThread root: ${'f'.repeat(64)}\n</context>`},{type:'text',text:'synthetic'}]};
    const first=rpc(3,'session/prompt',params);await reached;await rpc(4,'session/prompt',params);
    assert.equal(wire.trim().split('\n').map(JSON.parse).find(v=>v.id===4).error.code,-32002);
    assert.equal(state.ownsChannel(channel),true);finish();await first;assert.equal(state.ownsChannel(channel),false);
  }finally{finish();await server.close();await state.release();await rm(dir,{recursive:true,force:true});}
});

test('preflight retains ownership once a cached conversation has been bound',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agy-bound-preflight-'));
  const state=new SessionState({dir,owner,relay}),peer=new SessionState({dir,owner,relay});
  const scope=await state.scope({channelId:channel,cwd:dir,model:'gemini-3.8-flash-high'});
  await state.save(scope,'cached-conversation');await state.release();
  let bound=false,calls=0;
  const server=createAcpServer({input:new PassThrough(),output:new PassThrough(),diagnostics:new PassThrough(),...isolatedServerOptions({
    sessionStateFactory:()=>state,identityFactory:async()=>owner,outboxFactory:()=>({enabled:false,configurationError:'synthetic invalid outbox'}),
    sessionFactory:()=>({setTrustedConversation(){bound=true;},prompt:async()=>{calls++;},close(){}})})});
  const rpc=(id,method,params)=>server.handle({jsonrpc:'2.0',id,method,params});
  try{
    await rpc(1,'initialize',{protocolVersion:1});await rpc(2,'session/new',{cwd:dir});
    await rpc(3,'session/prompt',{sessionId:[...server.sessions.keys()][0],prompt:[{type:'text',text:`<context>\nChannel: test (#${channel})\nThread root: ${'f'.repeat(64)}\n</context>`},{type:'text',text:'synthetic'}]});
    assert.equal(bound,true);assert.equal(calls,0);
    await assert.rejects(peer.ensureOwnership(channel),e=>e.code==='AGY_SESSION_STATE_BUSY');
  }finally{await server.close();await state.release();await peer.release();await rm(dir,{recursive:true,force:true});}
});
