import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { createSteeringCoordinator, claimPendingSteer } from '../src/steering.js';
import { acquireNativeLock } from '../src/native-lock.js';
const owner='ab'.repeat(32), channelId='123e4567-e89b-42d3-a456-426614174000';

test('outbox listing never mutates a live inflight record', async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'agy-readonly-list-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const box=new DeliveryOutbox({dir,owner});
  const id=await box.begin({channelId,replyTo:'f'.repeat(64),content:'synthetic'});
  const before=await readFile(box.path(id),'utf8');
  await box.list();
  assert.equal(await readFile(box.path(id),'utf8'),before);
});
test('a concurrent list cannot overwrite a successful publication checkpoint',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'agy-list-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const box=new DeliveryOutbox({dir,owner});
  const id=await box.begin({channelId,replyTo:'f'.repeat(64),content:'synthetic'});
  const raw=box.readRaw.bind(box);let entered,release,intercept=true;
  const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  box.readRaw=async(key)=>{const record=await raw(key);if(intercept){intercept=false;entered();await gate;}return record;};
  const scan=box.list();await ready;
  await box.update(id,{status:'sent',eventId:'c'.repeat(64)});release();await scan;
  assert.equal((await raw(id)).status,'sent');assert.equal((await raw(id)).eventId,'c'.repeat(64));
});
async function coordinator(t){
  const rootDir=await mkdtemp(join(tmpdir(),'agy-transient-lock-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
  return createSteeringCoordinator({rootDir,ownerId:owner,channelId,sessionId:'test-session',conversationId:'test-conversation',hookConfigured:true,injectorExclusive:true});
}
test('two simultaneous steering requests remain queued instead of poisoning the session',async(t)=>{
  const c=await coordinator(t);
  const results=await Promise.allSettled([c.enqueue('first',{claimFloorStep:0}),c.enqueue('second',{claimFloorStep:0})]);
  assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));
  assert.equal((await c.snapshot()).queue.length,2);
});
test('claim waits for a transient writer without claiming a correction twice',async(t)=>{
  const c=await coordinator(t);await c.enqueue('synthetic correction',{claimFloorStep:0});
  const lock=await acquireNativeLock(join(c.bridgeDir,'.steering.lock'));
  const release=pause(1200).then(()=>lock.release());
  let result;try{result=await claimPendingSteer({bridgeDir:c.bridgeDir,bindingToken:c.bindingToken,input:{conversationId:'test-conversation',invocationNum:1,workspacePaths:[]}});}finally{await release;}
  assert.equal(result.injectSteps?.length,1);
  assert.deepEqual(await claimPendingSteer({bridgeDir:c.bridgeDir,bindingToken:c.bindingToken,input:{conversationId:'test-conversation',invocationNum:2,workspacePaths:[]}}),{});
});

test('a persistently held steering lock times out without altering queued state',async(t)=>{
  const c=await coordinator(t);await c.enqueue('held correction',{claimFloorStep:0});
  const before=await readFile(c.paths.state,'utf8');
  const lock=await acquireNativeLock(join(c.bridgeDir,'.steering.lock'));
  try { await assert.rejects(c.enqueue('must not append',{claimFloorStep:0}),e=>e.code==='AGY_NATIVE_LOCK_BUSY'); }
  finally { await lock.release(); }
  assert.equal(await readFile(c.paths.state,'utf8'),before);
});
