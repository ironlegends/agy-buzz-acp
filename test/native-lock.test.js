import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireNativeLock, createNativeLockAdapter } from '../src/native-lock.js';
import { SessionState } from '../src/session-state.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';

const owner = 'ab'.repeat(32);
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const relay = 'wss://relay.example.test/socket';

async function tempDir(prefix = 'agy-native-lock-') {
  return mkdtemp(join(tmpdir(), prefix));
}

function childLockScript(lockPath, action = 'hold') {
  const script = `
    import { acquireNativeLock } from ${JSON.stringify(new URL('../src/native-lock.js', import.meta.url).href)};
    const lockPath = process.env.AGY_TEST_LOCK_PATH;
    try {
      const lock = await acquireNativeLock(lockPath);
      process.stdout.write(JSON.stringify({ status: 'acquired' }) + '\\n');
      if (process.env.AGY_TEST_LOCK_ACTION === 'hold') await new Promise(() => setInterval(() => {}, 1000));
      await lock.release();
      process.stdout.write(JSON.stringify({ status: 'released' }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'blocked', code: error.code, message: error.message }) + '\\n');
      process.exitCode = 2;
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: isolatedChildEnvironment({ AGY_TEST_LOCK_PATH: lockPath, AGY_TEST_LOCK_ACTION: action }),
    windowsHide: true
  });
}

function waitForLine(child, predicate = () => true) {
  let output = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      for (const line of output.split('\n').slice(0, -1)) {
        try {
          const value = JSON.parse(line);
          if (predicate(value)) {
            child.stdout.off('data', onData);
            resolve(value);
            return;
          }
        } catch { /* wait for a complete JSON line */ }
      }
      output = output.slice(output.lastIndexOf('\n') + 1);
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

test('native lock serializes a real second process and remains blocked while holder lives', async () => {
  const dir = await tempDir();
  const lockPath = join(dir, 'session.lock');
  const holder = childLockScript(lockPath);
  try {
    assert.deepEqual(await waitForLine(holder), { status: 'acquired' });
    await assert.rejects(acquireNativeLock(lockPath), (error) => error.code === 'AGY_NATIVE_LOCK_BUSY');
    holder.kill();
    await new Promise((resolve) => holder.once('close', resolve));
    const afterKill = await acquireNativeLock(lockPath);
    await afterKill.release();
  } finally {
    holder.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native lock serializes distinct owners in one process', async () => {
  const dir = await tempDir();
  const lockPath = join(dir, 'same-process.lock');
  const first = await acquireNativeLock(lockPath);
  try {
    await assert.rejects(acquireNativeLock(lockPath), (error) => error.code === 'AGY_NATIVE_LOCK_BUSY');
  } finally {
    await first.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native lock rejects a legacy lock directory without deleting it', async () => {
  const dir = await tempDir();
  const lockPath = join(dir, 'legacy.lock');
  await mkdir(lockPath);
  try {
    await assert.rejects(acquireNativeLock(lockPath), (error) => error.code === 'AGY_NATIVE_LOCK_LEGACY');
    assert.equal((await lstat(lockPath)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native lock rejects symlink lock paths and preserves the target', async (t) => {
  const dir = await tempDir();
  const target = join(dir, 'target.lock');
  const link = join(dir, 'link.lock');
  await writeFile(target, '', { mode: 0o600 });
  try { await symlink(target, link); }
  catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('the current Windows account cannot create symlinks');
      await rm(dir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  try {
    await assert.rejects(acquireNativeLock(link), (error) => error.code === 'AGY_NATIVE_LOCK_SYMLINK');
    assert.equal((await lstat(target)).isFile(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native lock refuses an unsafe existing lock-file mode', async () => {
  if (process.platform === 'win32') return;
  const dir = await tempDir();
  const lockPath = join(dir, 'unsafe.lock');
  await writeFile(lockPath, '', { mode: 0o666 });
  await chmod(lockPath, 0o666);
  try {
    await assert.rejects(acquireNativeLock(lockPath), (error) => error.code === 'AGY_NATIVE_LOCK_PERMISSIONS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native lock fails closed when the native binding is unavailable', async () => {
  const dir = await tempDir();
  try {
    const adapter = createNativeLockAdapter({ binding: null });
    await assert.rejects(adapter.acquire(join(dir, 'unavailable.lock')), (error) => error.code === 'AGY_NATIVE_LOCK_UNAVAILABLE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session ownership retains a native lock file and releases it without unlinking', async () => {
  const dir = await tempDir('agy-native-session-');
  const state = new SessionState({ dir, owner, relay });
  try {
    await state.ensureOwnership(channelId);
    await state.release();
    const lockEntry = (await readdir(dir, { withFileTypes: true })).find((entry) => entry.name.endsWith('.lock'));
    assert.ok(lockEntry?.isFile());
  } finally {
    await state.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('outbox retry uses the native lock and refuses a legacy claim directory', async () => {
  const dir = await tempDir('agy-native-outbox-');
  const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'native-retry' });
  try {
    const id = await outbox.begin({ channelId, replyTo: 'a'.repeat(64), content: 'final' });
    await outbox.update(id, { status: 'failed-before-start' });
    await mkdir(join(dir, `${id}.lock`));
    let calls = 0;
    assert.deepEqual(await outbox.retry(id, { owner: '1'.repeat(64), publish: async () => { calls += 1; return { status: 'sent' }; } }),
      { status: 'blocked', reason: 'busy' });
    assert.equal(calls, 0);
    assert.equal((await lstat(join(dir, `${id}.lock`))).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
