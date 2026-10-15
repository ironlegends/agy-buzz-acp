import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireNativeLock } from './native-lock.js';

const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_RE = /^[0-9a-f]{64}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
export const SESSION_STATE_STORE_MARKER = '.agy-session-state-store';
const STORE_KIND = 'agy-session-state';
const INIT_LOCK_DIR = join(tmpdir(), 'agy-buzz-session-state-init-v1');

function storeError(message, code) {
  return Object.assign(new Error(message), { code, rpcMessage: message });
}

export function canonicalChannelId(channelId) {
  return typeof channelId === 'string' && CHANNEL_RE.test(channelId) ? channelId.toLowerCase() : null;
}

export function sessionStateChannelHash(channelId) {
  const canonical = canonicalChannelId(channelId);
  if (!canonical) throw storeError('agy session state scope is invalid', 'AGY_SESSION_STATE_SCOPE');
  return createHash('sha256').update(canonical).digest('hex');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertNoSymlinkAncestors(target) {
  let current = resolve(target);
  for (;;) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw storeError('agy session state path must not contain a symlink', 'AGY_SESSION_STATE_PATH');
      if (current !== resolve(target) && !stat.isDirectory()) {
        throw storeError('agy session state ancestor must be a directory', 'AGY_SESSION_STATE_PATH');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function ensureInitializationLockDirectory() {
  await assertNoSymlinkAncestors(INIT_LOCK_DIR);
  const existing = await lstat(INIT_LOCK_DIR).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw storeError('agy session state initialization lock directory is unsafe', 'AGY_SESSION_STATE_PATH');
  }
  if (!existing) await mkdir(INIT_LOCK_DIR, { recursive: true, mode: 0o700 });
  await chmod(INIT_LOCK_DIR, 0o700);
  const secured = await lstat(INIT_LOCK_DIR);
  if (!secured.isDirectory() || secured.isSymbolicLink() ||
      (process.platform !== 'win32' && (secured.mode & 0o077) !== 0)) {
    throw storeError('agy session state initialization lock directory is unsafe', 'AGY_SESSION_STATE_PATH');
  }
}

export async function assertSafeSessionStatePath(target) {
  await assertNoSymlinkAncestors(target);
}

export async function acquireSessionStateStoreInitializationLock(dir, lockFn = acquireNativeLock) {
  if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir) || typeof lockFn !== 'function') {
    throw storeError('agy session state directory is invalid', 'AGY_SESSION_STATE_PATH');
  }
  await ensureInitializationLockDirectory();
  const lockKey = createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex');
  return lockFn(join(INIT_LOCK_DIR, `${lockKey}.lock`));
}

export async function readSessionStateFile(path, maxBytes = 64 * 1024) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
    throw storeError('agy session state file is unsafe or exceeds its read limit', 'AGY_SESSION_STATE_FILE');
  }
  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await lstat(path, { bigint: true });
    if (!opened.isFile() || !afterOpen.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino || opened.nlink !== 1n ||
        afterOpen.nlink !== 1n || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs ||
        opened.ctimeNs !== before.ctimeNs) {
      throw storeError('agy session state file changed while opening', 'AGY_SESSION_STATE_FILE');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    const afterReadPath = await lstat(path, { bigint: true });
    if (bytesRead > maxBytes || bytesRead !== Number(opened.size) ||
        !sameFile(opened, afterRead) || !sameFile(afterRead, afterReadPath)) {
      throw storeError('agy session state file changed while reading', 'AGY_SESSION_STATE_FILE');
    }
    const bytes = buffer.subarray(0, bytesRead);
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), stat: afterRead };
  } finally {
    await handle?.close();
  }
}

function markerFor(owner, relayHash) {
  if (!OWNER_RE.test(owner ?? '') || !HASH_RE.test(relayHash ?? '')) {
    throw storeError('agy session state store binding is invalid', 'AGY_SESSION_STATE_STORE_MISMATCH');
  }
  return {
    schemaVersion: 1,
    kind: STORE_KIND,
    channelKey: 'lowercase-uuid-sha256-v1',
    owner: owner.toLowerCase(),
    relay: relayHash
  };
}

export function validateSessionStateStoreMarker(actual, { owner, relayHash } = {}) {
  const keys = actual && typeof actual === 'object' && !Array.isArray(actual)
    ? Object.keys(actual).sort().join(',') : '';
  if (keys !== 'channelKey,kind,owner,relay,schemaVersion' || actual.schemaVersion !== 1 ||
      actual.kind !== STORE_KIND || actual.channelKey !== 'lowercase-uuid-sha256-v1' ||
      !OWNER_RE.test(actual.owner ?? '') || actual.owner !== actual.owner.toLowerCase() || !HASH_RE.test(actual.relay ?? '') ||
      (owner !== undefined && actual.owner !== owner.toLowerCase()) ||
      (relayHash !== undefined && actual.relay !== relayHash)) {
    throw storeError('agy session state store binding does not match configuration', 'AGY_SESSION_STATE_STORE_MISMATCH');
  }
  return actual;
}

async function validateMarker(path, expected) {
  let file;
  try { file = await readSessionStateFile(path, 1024); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  let actual;
  try { actual = JSON.parse(file.text); }
  catch { throw storeError('agy session state store marker is corrupted', 'AGY_SESSION_STATE_STORE_MISMATCH'); }
  validateSessionStateStoreMarker(actual, { owner: expected.owner, relayHash: expected.relay });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw storeError('agy session state store binding does not match configuration', 'AGY_SESSION_STATE_STORE_MISMATCH');
  }
  return true;
}

export async function initializeSessionStateStore({ dir, owner, relayHash, lockFn = acquireNativeLock } = {}) {
  if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir) || typeof lockFn !== 'function') {
    throw storeError('agy session state directory is invalid', 'AGY_SESSION_STATE_PATH');
  }
  const expected = markerFor(owner, relayHash);
  const path = resolve(dir);
  await assertNoSymlinkAncestors(path);
  const lock = await acquireSessionStateStoreInitializationLock(path, lockFn);
  try {
    await assertNoSymlinkAncestors(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError('agy session state directory must be a real directory', 'AGY_SESSION_STATE_PATH');
    }
    const markerPath = join(path, SESSION_STATE_STORE_MARKER);
    if (await validateMarker(markerPath, expected)) {
      await chmod(path, 0o700);
      return { markerPath, initialized: false };
    }
    const entries = await readdir(path);
    if (entries.length !== 0) {
      throw storeError('agy session state store is unmarked and nonempty; controlled migration is required',
        'AGY_SESSION_STATE_LEGACY_STORE');
    }
    await chmod(path, 0o700);
    const markerBytes = `${JSON.stringify(expected)}\n`;
    const markerHandle = await open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await markerHandle.writeFile(markerBytes, 'utf8'); }
    finally { await markerHandle.close(); }
    await chmod(markerPath, 0o600);
    return { markerPath, initialized: true };
  } finally {
    await lock.release();
  }
}

export function sessionStateStoreMarkerPath(dir) {
  return join(dir, SESSION_STATE_STORE_MARKER);
}

export function sessionStateStoreInitLockRoot() {
  return INIT_LOCK_DIR;
}
