import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { SessionState, ownershipFailureReason } from '../src/session-state.js';
const owner = 'ab'.repeat(32), channel = '123e4567-e89b-42d3-a456-426614174000';
const secret = 'private-conversation-marker';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir };
}
for (const [native, expected] of [['AGY_NATIVE_LOCK_BUSY','AGY_SESSION_STATE_BUSY'],['AGY_NATIVE_LOCK_LEGACY','AGY_SESSION_STATE_LEGACY_LOCK'],['EACCES','AGY_SESSION_STATE_PERMISSIONS'],['EPERM','AGY_SESSION_STATE_PERMISSIONS'],['AGY_NATIVE_LOCK_PERMISSIONS','AGY_SESSION_STATE_PERMISSIONS'],['AGY_NATIVE_LOCK_UNAVAILABLE','AGY_SESSION_STATE_NATIVE_UNAVAILABLE'],['AGY_NATIVE_LOCK_SYMLINK','AGY_SESSION_STATE_UNSAFE_LOCK'],['AGY_NATIVE_LOCK_INODE','AGY_SESSION_STATE_UNSAFE_LOCK'],['AGY_NATIVE_LOCK_TYPE','AGY_SESSION_STATE_UNSAFE_LOCK'],['wrapped-EACCES','AGY_SESSION_STATE_PERMISSIONS'],['wrapped-no-cause','AGY_SESSION_STATE'],['UNEXPECTED','AGY_SESSION_STATE']]) {
  test(`ownership preserves safe category ${native}`, async (t) => {
    const {dir}=await fixture(t);
    const state = new SessionState({ dir, owner, relay:'wss://probe.invalid', lockFn:async () => { throw Object.assign(new Error(secret), native === 'wrapped-EACCES' ? {code:'AGY_NATIVE_LOCK_FAILED',cause:{code:'EACCES',message:secret}} : {code:native === 'wrapped-no-cause' ? 'AGY_NATIVE_LOCK_FAILED' : native}); } });
    let caught;
    await assert.rejects(state.ensureOwnership(channel), error => { caught=error; return error.code === expected && !error.message.includes(secret); });
    const reason=ownershipFailureReason(caught);
    assert.equal(reason.includes(secret),false);
    assert.equal(reason.includes('held elsewhere'),expected==='AGY_SESSION_STATE_BUSY');
  });
}
test('invalid channel fails before attempting ownership', async (t) => {
  const {dir}=await fixture(t); let calls=0;
  const s=new SessionState({dir,owner,relay:'wss://probe.invalid',lockFn:()=>{ calls++; }});
  await assert.rejects(s.ensureOwnership('../invalid'),{ code:'AGY_SESSION_STATE_SCOPE' }); assert.equal(calls,0);
});

test('untrusted diagnostic codes never select inherited properties', () => {
  for (const code of ['toString','constructor','__proto__']) assert.equal(ownershipFailureReason({code}), 'channel ownership could not be established');
});

for (const method of ['mkdir','chmod']) test(`directory ${method} permission failure is categorized without leaking paths`, async (t) => {
  const {dir}=await fixture(t); const before=await readdir(dir);
  const state=new SessionState({dir,owner,relay:'wss://probe.invalid'});
  try {
    t.mock.method(fsPromises,method,async()=>{throw Object.assign(new Error(secret),{code:'EACCES'});});
    syncBuiltinESMExports();
    await assert.rejects(state.ensureOwnership(channel),error => error.code==='AGY_SESSION_STATE_PERMISSIONS' && ownershipFailureReason(error).includes('permissions') && !JSON.stringify(error).includes(secret));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(dir),before);
});
