import { createRequire } from 'node:module';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);
let nativeBinding = null;
let nativeBindingError = null;

try {
  nativeBinding = require('fs-native-extensions');
} catch (error) {
  nativeBindingError = error;
}

function lockError(message, code, cause) {
  const error = Object.assign(new Error(message, cause ? { cause } : undefined), { code, rpcMessage: message });
  return error;
}

function isSafeMode(mode, mask) {
  return (mode & mask) === 0;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSupportedBinding(binding) {
  return binding && typeof binding.tryLock === 'function' && typeof binding.unlock === 'function';
}

async function inspectParent(lockPath) {
  const parent = dirname(lockPath);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (error) {
    throw lockError('agy native lock directory is unavailable', 'AGY_NATIVE_LOCK_DIRECTORY', error);
  }
  let current = parent;
  while (true) {
    const currentStat = current === parent ? parentStat : await lstat(current);
    if (currentStat.isSymbolicLink()) throw lockError('agy native lock directory must not be a symlink', 'AGY_NATIVE_LOCK_SYMLINK');
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  if (!parentStat.isDirectory()) throw lockError('agy native lock directory is not a directory', 'AGY_NATIVE_LOCK_DIRECTORY');
  if (process.platform !== 'win32' && !isSafeMode(parentStat.mode, 0o077)) {
    throw lockError('agy native lock directory permissions are unsafe', 'AGY_NATIVE_LOCK_PERMISSIONS');
  }
}

async function inspectLockPath(lockPath) {
  try {
    const stat = await lstat(lockPath);
    if (stat.isSymbolicLink()) throw lockError('agy native lock path must not be a symlink', 'AGY_NATIVE_LOCK_SYMLINK');
    if (stat.isDirectory()) throw lockError('agy legacy lock directory is unsupported', 'AGY_NATIVE_LOCK_LEGACY');
    if (!stat.isFile()) throw lockError('agy native lock path must be a regular file', 'AGY_NATIVE_LOCK_TYPE');
    if (process.platform !== 'win32' && !isSafeMode(stat.mode, 0o077)) {
      throw lockError('agy native lock file permissions are unsafe', 'AGY_NATIVE_LOCK_PERMISSIONS');
    }
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function acquire(binding, lockPath) {
  if (!isSupportedBinding(binding)) {
    throw lockError('agy native file locking is unavailable', 'AGY_NATIVE_LOCK_UNAVAILABLE', nativeBindingError);
  }
  if (typeof lockPath !== 'string' || !lockPath.trim() || !isAbsolute(lockPath)) {
    throw lockError('agy native lock path is invalid', 'AGY_NATIVE_LOCK_SCOPE');
  }

  await inspectParent(lockPath);
  const before = await inspectLockPath(lockPath);
  let file;
  try {
    // Node opens descriptors non-inheritable by default. The descriptor stays
    // open for the complete ownership lifetime so the OS lock stays held.
    file = await open(lockPath, 'a+', 0o600);
    const after = await inspectLockPath(lockPath);
    const opened = await file.stat();
    if (!after || !sameInode(after, opened) || (before && !sameInode(before, after))) {
      throw lockError('agy native lock path changed while opening', 'AGY_NATIVE_LOCK_INODE');
    }
    if (process.platform !== 'win32' && !isSafeMode(after.mode, 0o077)) {
      throw lockError('agy native lock file permissions are unsafe', 'AGY_NATIVE_LOCK_PERMISSIONS');
    }
    if (!binding.tryLock(file.fd)) {
      throw lockError('agy native lock is owned by another adapter', 'AGY_NATIVE_LOCK_BUSY');
    }
  } catch (error) {
    await file?.close().catch(() => {});
    throw error?.code?.startsWith('AGY_NATIVE_LOCK_')
      ? error
      : lockError('agy native lock could not be established', 'AGY_NATIVE_LOCK_FAILED', error);
  }

  let released = false;
  return {
    path: lockPath,
    fd: file.fd,
    async release() {
      if (released) return;
      released = true;
      let failure;
      try {
        binding.unlock(file.fd);
      } catch (error) {
        failure = lockError('agy native lock could not be released', 'AGY_NATIVE_LOCK_RELEASE', error);
      } finally {
        await file.close().catch((error) => { failure ??= lockError('agy native lock descriptor could not be closed', 'AGY_NATIVE_LOCK_RELEASE', error); });
      }
      if (failure) throw failure;
    }
  };
}

export function createNativeLockAdapter({ binding = nativeBinding } = {}) {
  return { acquire: (lockPath) => acquire(binding, lockPath) };
}

export const nativeLockAdapter = createNativeLockAdapter();

export function acquireNativeLock(lockPath) {
  return nativeLockAdapter.acquire(lockPath);
}
