import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctorReport } from '../src/doctor.js';
const owner='ab'.repeat(32), channel='11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'agy-doctor-steer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const binding={ownerId:owner,channelId:channel,sessionId:'session-probe',conversationId:'conversation-probe',nonce:'11'.repeat(16)};
  const {conversationId,...stable}=binding;
  const state={schemaVersion:1,bindingToken:createHash('sha256').update(JSON.stringify(stable)).digest('hex'),status:'blocked',guardBlocked:true,activeSteerId:null,queue:[],nextSequence:1,updatedAt:1};
  const bridge=join(root,'channel-'+createHash('sha256').update(`${owner}:${channel}`).digest('hex'));
  await mkdir(bridge); await writeFile(join(bridge,'binding.json'),JSON.stringify(binding)); await writeFile(join(bridge,'state.json'),JSON.stringify(state));
  return {root,bridge,binding,state,env:{AGY_STEER_ROOT_DIR:root,AGY_STEER_OWNER:owner,AGY_STEER_HOOK_CONFIGURED:'1',AGY_STEER_INJECTOR_EXCLUSIVE:'1'}};
}
async function doctor(env) { return runDoctor({env,spawnImpl:()=>{throw new Error('offline must not spawn');}}); }
test('doctor inspects blocked steering read-only and names missing recovery prerequisites',async t=>{
  const f=await fixture(t), before=await readFile(join(f.bridge,'state.json'),'utf8');
  const report=await doctor(f.env);
  assert.equal(report.steering.status,'warn'); assert.equal(report.steering.bridges.blocked,1);
  assert.equal(report.steering.automaticRecoveryConfigured,false);
  const text=formatDoctorReport(report);assert.match(text,/blocked=1/);assert.match(text,/-archived-/);assert.match(text,/warnings/);
  assert.match(report.steering.guidance,/stop.*archive/i); assert.match(report.steering.guidance,/never delete/i);
  assert.equal(await readFile(join(f.bridge,'state.json'),'utf8'),before);
  assert.deepEqual((await readdir(f.bridge)).sort(),['binding.json','state.json']);
  const result=JSON.stringify(report.steering);
  for(const secret of [owner,channel,'conversation-probe',f.root,'11'.repeat(16)]) assert.equal(result.includes(secret),false);
});
test('doctor does not count archived bridges as active blockers',async t=>{
  const f=await fixture(t); await mkdir(f.bridge+'-archived-test');
  f.state.status='ready'; f.state.guardBlocked=false; await writeFile(join(f.bridge,'state.json'),JSON.stringify(f.state));
  const r=await doctor(f.env); assert.equal(r.steering.bridges.ready,1); assert.equal(r.steering.bridges.blocked,0);
  assert.equal(r.steering.bridges.archived,1);
});
for(const scenario of ['corrupt','foreign','oversized','binding-mismatch']) test(`doctor rejects ${scenario} steering metadata`,async t=>{
  const f=await fixture(t);
  if(scenario==='corrupt') await writeFile(join(f.bridge,'state.json'),'{');
  if(scenario==='foreign') {f.binding.ownerId='cd'.repeat(32); await writeFile(join(f.bridge,'binding.json'),JSON.stringify(f.binding));}
  if(scenario==='oversized') await writeFile(join(f.bridge,'state.json'),' '.repeat(262145));
  if(scenario==='binding-mismatch') {f.state.bindingToken='f'.repeat(64); await writeFile(join(f.bridge,'state.json'),JSON.stringify(f.state));}
  const r=await doctor(f.env); assert.equal(r.steering.status,'warn'); assert.equal(r.steering.bridges.invalid,1);
});
test('missing and partial steering configuration are not reported as healthy enabled steering',async()=>{
  assert.equal((await doctor({})).steering.enabled,false);
  const r=await doctor({AGY_STEER_HOOK_CONFIGURED:'1'}); assert.equal(r.steering.status,'fail'); assert.equal(r.ok,false);
});
test('configured recovery is not a claim that a blocked bridge is safe to repair',async t=>{
  const f=await fixture(t); const r=await doctor({...f.env,AGY_SESSION_DIR:f.root,AGY_SESSION_OWNER:owner,AGY_OUTBOX_DIR:f.root,AGY_OUTBOX_OWNER:owner,BUZZ_RELAY_URL:'wss://test.invalid'});
  assert.equal(r.steering.automaticRecoveryConfigured,true); assert.equal(r.steering.status,'warn');
  assert.match(r.steering.guidance,/provider.*delivery/i);
});
test('doctor refuses symlinked steering metadata without reading its target',async t=>{
  const f=await fixture(t), target=join(f.root,'private.json'); await writeFile(target,'{"private":"do not read"}');
  await rm(join(f.bridge,'binding.json'));
  try { await symlink(target,join(f.bridge,'binding.json'),'file'); } catch(e) {if(['EPERM','EACCES'].includes(e.code)){t.skip('no symlink privilege');return;}throw e;}
  const r=await doctor(f.env); assert.equal(r.steering.bridges.invalid,1); assert.equal(JSON.stringify(r).includes('do not read'),false);
});
