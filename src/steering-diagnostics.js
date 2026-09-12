// Read-only steering diagnostics. No hook, provider, lock or ACL mutation is run.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSteeringSnapshot, readBooleanFlag } from './steering.js';
const OWNER = /^[a-f0-9]{64}$/i;
const LIMIT = 256 * 1024;
export const MAX_STEERING_DIAGNOSTIC_ENTRIES = 1000;

async function directory(path, fs) {
  let current = resolve(path);
  for (;;) {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe directory');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function json(path, fs) {
  const before = await fs.lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > LIMIT) throw new Error('unsafe record');
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > LIMIT || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error('changed record');
    const bytes = Buffer.alloc(LIMIT + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > LIMIT) throw new Error('oversized record');
    const after = await fs.lstat(path);
    if (after.isSymbolicLink() || !after.isFile() || before.ino !== after.ino || before.dev !== after.dev) throw new Error('changed record');
    return JSON.parse(bytes.subarray(0, used).toString());
  } finally { await handle.close(); }
}
export async function inspectSteeringDiagnostics(env, { fsImpl = {}, maxEntries = MAX_STEERING_DIAGNOSTIC_ENTRIES } = {}) {
  const fs = { lstat, readdir, open, ...fsImpl };
  const configured = ['AGY_STEER_HOOK_CONFIGURED','AGY_STEER_INJECTOR_EXCLUSIVE','AGY_STEER_OWNER','AGY_STEER_ROOT_DIR'].some(k => Boolean(env[k]));
  const owner = env.AGY_STEER_OWNER ?? env.AGY_SESSION_OWNER;
  const enabled = readBooleanFlag(env.AGY_STEER_HOOK_CONFIGURED) && readBooleanFlag(env.AGY_STEER_INJECTOR_EXCLUSIVE) && OWNER.test(owner ?? '');
  const automaticRecoveryConfigured = Boolean(enabled && env.AGY_SESSION_DIR && env.AGY_OUTBOX_DIR && env.BUZZ_RELAY_URL &&
    OWNER.test(env.AGY_SESSION_OWNER ?? '') && OWNER.test(env.AGY_OUTBOX_OWNER ?? '') &&
    env.AGY_SESSION_OWNER.toLowerCase() === owner.toLowerCase() && env.AGY_OUTBOX_OWNER.toLowerCase() === owner.toLowerCase());
  const result = { configured, enabled, automaticRecoveryConfigured, status:'pass',
    message: configured ? 'Steering is explicitly disabled' : 'Steering is not configured',
    bridges:{ ready:0, blocked:0, invalid:0, archived:0 }, scan:{ inspected:0, truncated:false }, guidance:'' };
  if (!configured) return result;
  if (!enabled) {
    if (readBooleanFlag(env.AGY_STEER_HOOK_CONFIGURED) || readBooleanFlag(env.AGY_STEER_INJECTOR_EXCLUSIVE)) {
      result.status='fail'; result.message='Steering requires both opt-in flags and a valid public owner';
    }
    return result;
  }
  const root = env.AGY_STEER_ROOT_DIR || join(tmpdir(),'agy-buzz-steering');
  result.message='Steering metadata inspected; running provider, hook execution and ACL privacy are not verified';
  result.guidance=automaticRecoveryConfigured
    ? 'Automatic recovery still requires confirmed provider retirement, channel ownership and settled delivery; do not force an unlock.'
    : 'Automatic bridge recovery requires matching durable session state and a readable delivery outbox. To recover manually: stop all affected adapters and providers, preserve state and verify uncertain provider and delivery effects; only then archive the bridge to a sibling -archived-<stamp> directory; never delete it to force a retry.';
  if (!automaticRecoveryConfigured) result.status='warn';
  try {
    if (!isAbsolute(root)) throw new Error('relative directory');
    await directory(root,fs);
    const names=await fs.readdir(root);
    const limit=Number.isInteger(maxEntries) && maxEntries>0 ? Math.min(maxEntries,MAX_STEERING_DIAGNOSTIC_ENTRIES) : MAX_STEERING_DIAGNOSTIC_ENTRIES;
    const chosen=names.slice(0,limit);
    result.scan.truncated=names.length>chosen.length;
    for(const name of chosen) {
      if(!/^channel-[a-f0-9]{64}/i.test(name)) continue;
      if(/^channel-[a-f0-9]{64}-archived-/i.test(name)) {result.bridges.archived++; continue;}
      if(!/^channel-[a-f0-9]{64}$/i.test(name)) {result.bridges.invalid++;continue;}
      result.scan.inspected++;
      try {
        const bridge=join(root,name); await directory(bridge,fs);
        const binding=await json(join(bridge,'binding.json'),fs);
        const state=await json(join(bridge,'state.json'),fs);
        validateSteeringSnapshot(binding,state);
        const key=createHash('sha256').update(`${binding.ownerId}:${binding.channelId}`).digest('hex');
        if(binding.ownerId.toLowerCase()!==owner.toLowerCase() || name!==`channel-${key}`) throw new Error('foreign binding');
        const blocked=state.guardBlocked || ['blocked','queued','claimed'].includes(state.status) || state.activeSteerId !== null ||
          state.queue.some(e => ['queued','awaiting_user_input','blocked'].includes(e.status));
        result.bridges[blocked ? 'blocked' : 'ready']++;
      } catch { result.bridges.invalid++; }
    }
    if(result.bridges.blocked || result.bridges.invalid || result.scan.truncated) result.status='warn';
  } catch(e) {
    result.status='warn';
    result.message=e?.code==='ENOENT' ? 'Steering metadata has not been created or is missing' : 'Steering metadata could not be inspected safely';
  }
  return result;
}
