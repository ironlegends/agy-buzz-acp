import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { copyFile, lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireNativeLock } from '../src/native-lock.js';

const execFile = promisify(execFileCallback);

const ownerId = 'ab'.repeat(32);
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const otherChannelId = '223e4567-e89b-12d3-a456-426614174000';
const sessionId = 'ses_steering_test';
const conversationId = '188e2ee5-9c44-4d95-bdd5-23eeb2d93e47';
const otherConversationId = '288e2ee5-9c44-4d95-bdd5-23eeb2d93e47';

async function loadApi() {
  try {
    return await import('../src/steering.js');
  } catch (error) {
    assert.fail(`steering API is missing: ${error.message}`);
  }
}

async function createHarness(t, options = {}) {
  const api = await loadApi();
  const rootDir = await mkdtemp(join(tmpdir(), 'agy-steering-test-'));
  const coordinator = await api.createSteeringCoordinator({
    rootDir,
    ownerId,
    channelId,
    sessionId,
    conversationId,
    injectorExclusive: true,
    hookConfigured: true,
    ...options
  });
  t.after(async () => { await rm(rootDir, { recursive: true, force: true }); });
  return { api, rootDir, coordinator };
}

async function runHook(api, input, env) {
  return api.runSteeringHook({ input, env });
}

async function runHookCommand(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/agy-buzz-steer-hook.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`steering helper exited with ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim() || '{}'));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function providerInput(overrides = {}) {
  return { conversationId, invocationNum: 0, workspacePaths: [], ...overrides };
}

async function directorySecuritySnapshot(path) {
  if (process.platform === 'win32') {
    const { stdout, stderr } = await execFile('icacls', [path], { windowsHide: true, maxBuffer: 32 * 1024 });
    return `${stdout}\n${stderr}`;
  }
  return (await lstat(path)).mode & 0o777;
}

test('steering stays disabled until the exclusive dedicated hook is explicitly configured', async (t) => {
  const api = await loadApi();
  const rootDir = await mkdtemp(join(tmpdir(), 'agy-steering-disabled-'));
  t.after(async () => { await rm(rootDir, { recursive: true, force: true }); });

  const coordinator = await api.createSteeringCoordinator({
    rootDir, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: false, hookConfigured: true
  });

  assert.equal(coordinator.enabled, false);
  assert.equal(coordinator.bridgeEnv(), null);
  await assert.rejects(coordinator.enqueue('ignored', { claimFloorStep: 0 }),
    (error) => error.code === 'AGY_STEER_UNAVAILABLE');
  assert.deepEqual(await readdir(rootDir), []);
});

test('a bootstrap bridge refuses claims until init binds the provider conversation', async (t) => {
  const api = await loadApi();
  const rootDir = await mkdtemp(join(tmpdir(), 'agy-steering-bootstrap-'));
  t.after(async () => { await rm(rootDir, { recursive: true, force: true }); });
  const coordinator = await api.createSteeringCoordinator({
    rootDir,
    ownerId,
    channelId,
    sessionId,
    conversationId: 'pending-steering',
    conversationBound: false,
    injectorExclusive: true,
    hookConfigured: true
  });
  await assert.rejects(coordinator.enqueue('before init', { claimFloorStep: 0 }),
    (error) => error.code === 'AGY_STEER_UNAVAILABLE');
  assert.deepEqual(await runHook(api, providerInput()), {});
  await coordinator.bindConversation(conversationId);
  const queued = await coordinator.enqueue('after init', { claimFloorStep: 0 });
  assert.deepEqual((await runHook(api, providerInput(), coordinator.bridgeEnv())).injectSteps,
    [{ userMessage: 'after init' }]);
  const outcome = await coordinator.observeUserInput({ conversationId, stepIndex: 1 });
  assert.equal(outcome.steerId, queued.steerId);
  assert.equal(coordinator.conversationBound, true);
});

test('binding validation rejects a changed owner, channel, session, or conversation', async (t) => {
  const { coordinator } = await createHarness(t);
  for (const field of ['ownerId', 'channelId', 'sessionId', 'conversationId']) {
    const value = field === 'ownerId' ? 'cd'.repeat(32)
      : field === 'channelId' ? otherChannelId
        : field === 'conversationId' ? otherConversationId : 'ses_other';
    assert.throws(() => coordinator.assertBinding({ [field]: value }),
      (error) => error.code === 'AGY_STEER_BINDING_MISMATCH', `changed ${field} must be rejected`);
  }
});

test('enqueue persists the claim watermark and blocked guard before exposing a request', async (t) => {
  const { coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const state = JSON.parse(await readFile(coordinator.paths.state, 'utf8'));
  const request = JSON.parse(await readFile(coordinator.paths.request(queued.steerId), 'utf8'));

  assert.equal(state.guardBlocked, true);
  assert.equal(state.status, 'queued');
  assert.equal(state.queue[0].claimFloorStep, 41);
  assert.equal(state.queue[0].steerId, queued.steerId);
  assert.equal(request.claimFloorStep, 41);
  assert.equal(request.status, 'queued');
  assert.equal(request.text, 'Correction A');
});

test('the helper claims one FIFO request and injects only a user message', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const result = await runHook(api, providerInput(), coordinator.bridgeEnv());

  assert.deepEqual(result, {
    injectSteps: [{ userMessage: 'Correction A' }],
    terminationBehavior: 'force_continue'
  });
  const state = await coordinator.snapshot();
  assert.equal(state.status, 'claimed');
  assert.equal(state.guardBlocked, true);
  assert.equal(state.activeSteerId, queued.steerId);
  assert.equal((await readFile(coordinator.paths.ack(queued.steerId), 'utf8')).includes('Correction A'), false);
  assert.deepEqual(await runHook(api, providerInput(), coordinator.bridgeEnv()), {});
});

test('reads an atomic snapshot while the native lock is held, then the real helper injects', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const lock = await acquireNativeLock(join(coordinator.bridgeDir, '.steering.lock'));
  try {
    const snapshot = await Promise.race([
      coordinator.snapshot(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot remained blocked')), 250))
    ]);
    assert.equal(snapshot.status, 'queued');
    assert.equal(snapshot.activeSteerId, null);
  } finally {
    await lock.release();
  }

  const result = await runHookCommand(providerInput(), coordinator.bridgeEnv());
  assert.deepEqual(result, {
    injectSteps: [{ userMessage: 'Correction A' }],
    terminationBehavior: 'force_continue'
  });
  assert.equal((await coordinator.snapshot()).activeSteerId, queued.steerId);
});

test('a durable native lock rejects block in a bound and preserves the guard', async (t) => {
  const { coordinator } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const lock = await acquireNativeLock(join(coordinator.bridgeDir, '.steering.lock'));
  const started = Date.now();
  try {
    await assert.rejects(coordinator.block('bounded lock contention'),
      (error) => error.code === 'AGY_NATIVE_LOCK_BUSY');
  } finally {
    await lock.release();
  }
  assert.ok(Date.now() - started < 1000, 'durable contention must not wait indefinitely');
  const state = JSON.parse(await readFile(coordinator.paths.state, 'utf8'));
  assert.equal(state.status, 'queued');
  assert.equal(state.guardBlocked, true);
  assert.equal(state.queue[0].status, 'queued');
});

test('the packaged helper command returns JSON and never writes diagnostics to stderr', async (t) => {
  const { coordinator } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const result = await runHookCommand(providerInput(), coordinator.bridgeEnv());

  assert.deepEqual(result, {
    injectSteps: [{ userMessage: 'Correction A' }],
    terminationBehavior: 'force_continue'
  });
});

test('the helper fails closed for foreign bridge, binding, conversation, or workspace metadata', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const foreignDir = await mkdtemp(join(rootDir, 'foreign-'));
  t.after(async () => { await rm(foreignDir, { recursive: true, force: true }); });

  assert.deepEqual(await runHook(api, providerInput(), {
    ...coordinator.bridgeEnv(), AGY_STEER_BRIDGE_DIR: foreignDir
  }), {});
  assert.deepEqual(await runHook(api, providerInput(), {
    ...coordinator.bridgeEnv(), AGY_STEER_BINDING: '00'.repeat(32)
  }), {});
  assert.deepEqual(await runHook(api, providerInput({ conversationId: otherConversationId }), coordinator.bridgeEnv()), {});
  assert.deepEqual(await runHook(api, providerInput({ workspacePaths: [rootDir] }), coordinator.bridgeEnv()), {});
  assert.equal((await coordinator.snapshot()).status, 'queued');
});

test('an acknowledgement alone does not confirm consumption', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());

  const ack = JSON.parse(await readFile(coordinator.paths.ack(queued.steerId), 'utf8'));
  assert.equal(ack.status, 'injected');
  assert.equal((await coordinator.snapshot()).status, 'claimed');
  assert.equal((await readFile(coordinator.paths.request(queued.steerId), 'utf8')).includes('Correction A'), true);
});

test('only a matching user_input strictly after the claim watermark confirms injection', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());

  const outcome = await coordinator.observeUserInput({ conversationId, stepIndex: 42 });
  assert.deepEqual(outcome, { outcome: 'injected', steerId: queued.steerId, sequence: 1, userInputStep: 42 });
  const state = await coordinator.snapshot();
  assert.equal(state.status, 'injected');
  assert.equal(state.guardBlocked, false);
  assert.equal(state.activeSteerId, null);
});

test('foreign or non-monotone user_input blocks the claim and prevents replay', async (t) => {
  const { api, coordinator } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());

  await assert.rejects(coordinator.observeUserInput({ conversationId: otherConversationId, stepIndex: 42 }),
    (error) => error.code === 'AGY_STEER_BLOCKED');
  assert.equal((await coordinator.snapshot()).status, 'blocked');
  assert.deepEqual(await runHook(api, providerInput(), coordinator.bridgeEnv()), {});
});

test('a claim that times out is durably blocked and cannot be replayed after reopen', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());
  await coordinator.block('provider timeout');

  const reopened = await api.createSteeringCoordinator({
    rootDir, bridgeDir: coordinator.bridgeDir, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: true, hookConfigured: true
  });
  assert.equal(reopened.enabled, true);
  assert.equal(reopened.blocked, true);
  assert.deepEqual(await runHook(api, providerInput(), reopened.bridgeEnv()), {});
  await assert.rejects(reopened.enqueue('Correction B', { claimFloorStep: 42 }),
    (error) => error.code === 'AGY_STEER_BLOCKED');
});

test('reports a blocked channel bridge before a restarted session has a conversation id', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  await coordinator.block('provider crash after claim');
  const status = await api.inspectSteeringBridge({
    rootDir,
    bridgeDir: coordinator.bridgeDir,
    ownerId,
    channelId
  });
  assert.deepEqual(status, { exists: true, blocked: true });
});

test('a cleanly completed bridge reopens with its persistent binding and accepts the next request', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());
  await coordinator.observeUserInput({ conversationId, stepIndex: 42 });

  const reopened = await api.createSteeringCoordinator({
    rootDir, bridgeDir: coordinator.bridgeDir, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: true, hookConfigured: true
  });
  const queued = await reopened.enqueue('Correction B', { claimFloorStep: 43 });
  const result = await runHook(api, providerInput({ invocationNum: 1 }), reopened.bridgeEnv());
  assert.deepEqual(result, { injectSteps: [{ userMessage: 'Correction B' }], terminationBehavior: 'force_continue' });
  assert.equal((await reopened.snapshot()).activeSteerId, queued.steerId);
});

test('a missing acknowledgement blocks a claimed request before it can be published', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const queued = await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  await runHook(api, providerInput(), coordinator.bridgeEnv());
  await rm(coordinator.paths.ack(queued.steerId));

  await assert.rejects(coordinator.observeUserInput({ conversationId, stepIndex: 42 }),
    (error) => error.code === 'AGY_STEER_BLOCKED');
  assert.equal((await coordinator.snapshot()).status, 'blocked');
});

test('a queued claim is blocked on reopen before the helper can consume it', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });

  const reopened = await api.createSteeringCoordinator({
    rootDir, bridgeDir: coordinator.bridgeDir, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: true, hookConfigured: true
  });
  assert.equal(reopened.blocked, true);
  assert.deepEqual(await runHook(api, providerInput(), reopened.bridgeEnv()), {});
});

test('FIFO permits the next correction only after the preceding user_input is confirmed', async (t) => {
  const { api, coordinator } = await createHarness(t);
  const first = await coordinator.enqueue('Correction A', { claimFloorStep: 10 });
  const second = await coordinator.enqueue('Correction B', { claimFloorStep: 12 });

  const firstInjection = await runHook(api, providerInput({ invocationNum: 0 }), coordinator.bridgeEnv());
  assert.deepEqual(firstInjection.injectSteps, [{ userMessage: 'Correction A' }]);
  assert.deepEqual(await runHook(api, providerInput({ invocationNum: 0 }), coordinator.bridgeEnv()), {});
  await coordinator.observeUserInput({ conversationId, stepIndex: 11 });

  const secondInjection = await runHook(api, providerInput({ invocationNum: 1 }), coordinator.bridgeEnv());
  assert.deepEqual(secondInjection.injectSteps, [{ userMessage: 'Correction B' }]);
  assert.equal((await coordinator.snapshot()).activeSteerId, second.steerId);
  const secondOutcome = await coordinator.observeUserInput({ conversationId, stepIndex: 13 });
  assert.deepEqual(secondOutcome, { outcome: 'injected', steerId: second.steerId, sequence: 2, userInputStep: 13 });
  assert.equal(first.sequence, 1);
});

test('concurrent hook invocations produce at most one claim', async (t) => {
  const { api, coordinator } = await createHarness(t);
  await coordinator.enqueue('Correction A', { claimFloorStep: 41 });
  const results = await Promise.all([
    runHook(api, providerInput({ invocationNum: 0 }), coordinator.bridgeEnv()),
    runHook(api, providerInput({ invocationNum: 0 }), coordinator.bridgeEnv())
  ]);
  assert.equal(results.filter((result) => result.injectSteps).length, 1);
  assert.equal(results.filter((result) => Object.keys(result).length === 0).length, 1);
  assert.equal((await coordinator.snapshot()).status, 'claimed');
});

test('a bridge symlink is rejected without touching its target', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  const link = join(rootDir, 'bridge-link');
  try { await symlink(coordinator.bridgeDir, link, 'junction'); }
  catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('the current Windows account cannot create directory links');
      return;
    }
    throw error;
  }
  await assert.rejects(api.createSteeringCoordinator({
    rootDir, bridgeDir: link, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: true, hookConfigured: true
  }), (error) => error.code === 'AGY_STEER_PATH');
  assert.equal((await lstat(coordinator.bridgeDir)).isDirectory(), true);
});

test('invalid and oversized steering text is rejected before a request is visible', async (t) => {
  const { coordinator } = await createHarness(t);
  await assert.rejects(coordinator.enqueue('', { claimFloorStep: 0 }), (error) => error.code === 'AGY_STEER_INPUT');
  await assert.rejects(coordinator.enqueue('x'.repeat(16_385), { claimFloorStep: 0 }),
    (error) => error.code === 'AGY_STEER_INPUT');
  await assert.rejects(coordinator.enqueue('valid', { claimFloorStep: -1 }),
    (error) => error.code === 'AGY_STEER_INPUT');
  assert.deepEqual((await coordinator.snapshot()).queue, []);
});

test('the helper rejects a foreign path or token without changing directory security', async (t) => {
  const { api, coordinator, rootDir } = await createHarness(t);
  const invalidTokenDir = await mkdtemp(join(rootDir, 'invalid-token-'));
  const foreignDir = await mkdtemp(join(rootDir, 'foreign-existing-'));
  t.after(async () => {
    await rm(invalidTokenDir, { recursive: true, force: true });
    await rm(foreignDir, { recursive: true, force: true });
  });

  await Promise.all([
    copyFile(coordinator.paths.binding, join(invalidTokenDir, 'binding.json')),
    copyFile(coordinator.paths.state, join(invalidTokenDir, 'state.json'))
  ]);
  const invalidTokenBefore = await directorySecuritySnapshot(invalidTokenDir);
  assert.deepEqual(await runHook(api, providerInput(), {
    ...coordinator.bridgeEnv(),
    AGY_STEER_BRIDGE_DIR: invalidTokenDir,
    AGY_STEER_BINDING: '00'.repeat(32)
  }), {});
  assert.equal(await directorySecuritySnapshot(invalidTokenDir), invalidTokenBefore);

  const foreignBefore = await directorySecuritySnapshot(foreignDir);
  assert.deepEqual(await runHook(api, providerInput(), {
    ...coordinator.bridgeEnv(), AGY_STEER_BRIDGE_DIR: foreignDir
  }), {});
  assert.equal(await directorySecuritySnapshot(foreignDir), foreignBefore);
});

test('an existing Windows bridge with an additional explicit account is refused', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows ACL validation is only applicable on Windows');
    return;
  }
  const { api, coordinator, rootDir } = await createHarness(t);
  await execFile('icacls', [coordinator.bridgeDir, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], {
    windowsHide: true, maxBuffer: 32 * 1024
  });

  await assert.rejects(api.createSteeringCoordinator({
    rootDir, bridgeDir: coordinator.bridgeDir, ownerId, channelId, sessionId, conversationId,
    injectorExclusive: true, hookConfigured: true
  }), (error) => error.code === 'AGY_STEER_PATH');
});
