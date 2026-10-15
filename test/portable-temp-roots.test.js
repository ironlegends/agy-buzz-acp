import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';

const childScript = `
  import { createHash } from 'node:crypto';
  import { lstat, realpath } from 'node:fs/promises';
  import { join } from 'node:path';
  import { PassThrough } from 'node:stream';
  import { initializeSessionStateStore, sessionStateStoreInitLockRoot } from ${JSON.stringify(new URL('../src/session-state-store.js', import.meta.url).href)};
  import { createSteeringCoordinator } from ${JSON.stringify(new URL('../src/steering.js', import.meta.url).href)};
  import { createAcpServer } from ${JSON.stringify(new URL('../src/acp-server.js', import.meta.url).href)};

  const ownerId = 'ab'.repeat(32);
  const channelId = '123e4567-e89b-12d3-a456-426614174000';
  const relayHash = 'cd'.repeat(32);
  const tempAlias = process.env.AGY_TEST_TEMP_ALIAS;
  const canonicalTemp = await realpath(tempAlias);
  const results = {};
  const capture = async (run) => {
    try { return { ok: true, value: await run() }; }
    catch (error) { return { ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }; }
  };

  results.stateInit = await capture(async () => initializeSessionStateStore({
    dir: process.env.AGY_TEST_STATE_DIR, owner: ownerId, relayHash
  }));
  results.reportedStateLockRoot = sessionStateStoreInitLockRoot();

  results.directSteering = await capture(async () => {
    const coordinator = await createSteeringCoordinator({
      ownerId, channelId, sessionId: 'direct-session', conversationId: 'direct-conversation',
      injectorExclusive: true, hookConfigured: true
    });
    return { enabled: coordinator.enabled, bridgeDir: coordinator.bridgeDir };
  });

  results.explicitStatePath = await capture(async () => initializeSessionStateStore({
    dir: join(tempAlias, 'explicit-state'), owner: ownerId, relayHash
  }));
  results.explicitSteeringRoot = await capture(async () => createSteeringCoordinator({
    rootDir: join(tempAlias, 'explicit-steering-root'), ownerId, channelId,
    sessionId: 'explicit-root-session', conversationId: 'explicit-root-conversation',
    injectorExclusive: true, hookConfigured: true
  }));
  results.explicitSteeringBridge = await capture(async () => createSteeringCoordinator({
    rootDir: join(canonicalTemp, 'explicit-safe-root'), bridgeDir: join(tempAlias, 'explicit-steering-bridge'),
    ownerId, channelId, sessionId: 'explicit-bridge-session', conversationId: 'explicit-bridge-conversation',
    injectorExclusive: true, hookConfigured: true
  }));

  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const responses = [];
  let pending = '';
  let fakeSessionCalls = 0;
  let publisherFactoryCalls = 0;
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  const server = createAcpServer({
    input, output, diagnostics,
    steeringConfig: { hookConfigured: true, injectorExclusive: true, ownerId },
    sessionStateFactory: () => null,
    outboxFactory: () => ({ enabled: false, configurationError: null }),
    sessionFactory: () => ({
      prompt: async () => { fakeSessionCalls += 1; throw new Error('synthetic stop from offline session stub'); },
      cancel() {}, close() {}, setSteeringCoordinator() {}, getConversationId: () => 'unused-conversation'
    }),
    publisherFactory: () => { publisherFactoryCalls += 1; throw new Error('synthetic stop after steering setup'); }
  });
  const waitFor = async (id) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = responses.find((item) => item.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for ACP response ' + id);
  };
  const send = (message) => input.write(JSON.stringify(message) + '\\n');

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await waitFor(1);
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionResponse = await waitFor(2);
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
      sessionId: sessionResponse.result.sessionId,
      prompt: [
        { type: 'text', text: '[Base]\\nPlatform context.' },
        { type: 'text', text: '[Context]\\nChannel: coordination (#' + channelId + ')\\nThread root: ' + 'f'.repeat(64) }
      ]
    } });
    results.acpPrompt = await waitFor(3);
  } finally {
    input.end();
    output.destroy();
    diagnostics.destroy();
  }

  const defaultSteeringRoot = join(canonicalTemp, 'agy-buzz-steering');
  const stateLockDir = join(canonicalTemp, 'agy-buzz-session-state-init-v1');
  const acpBridgeDir = join(defaultSteeringRoot, 'channel-' + createHash('sha256').update(ownerId + ':' + channelId).digest('hex'));
  const existsAsDirectory = async (path) => {
    try { return (await lstat(path)).isDirectory(); }
    catch { return false; }
  };
  results.defaultRoots = {
    canonicalTemp,
    stateLockDir,
    stateLockDirExists: await existsAsDirectory(stateLockDir),
    steeringRootExists: await existsAsDirectory(defaultSteeringRoot),
    acpBridgeExists: await existsAsDirectory(acpBridgeDir),
    directBridgeCanonical: results.directSteering.ok &&
      (await realpath(results.directSteering.value.bridgeDir)).startsWith(defaultSteeringRoot)
  };
  results.calls = { fakeSessionCalls, publisherFactoryCalls };
  process.stdout.write(JSON.stringify(results) + '\\n');
`;

test('canonicalizes only default OS temp roots in state, coordinator, and ACP runtimes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-portable-temp-roots-'));
  const realTemp = join(root, 'real-temp');
  const tempAlias = join(root, 'temp-alias');
  const stateDir = join(root, 'state-store');
  await mkdir(realTemp);
  try { await symlink(realTemp, tempAlias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error?.code === 'EPERM' && process.platform === 'win32') {
      t.skip('the current Windows account cannot create directory junctions');
      return;
    }
    throw error;
  }

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: isolatedChildEnvironment({
        TMPDIR: tempAlias,
        TEMP: tempAlias,
        TMP: tempAlias,
        AGY_TEST_TEMP_ALIAS: tempAlias,
        AGY_TEST_STATE_DIR: stateDir
      }),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const actual = JSON.parse(result.stdout);

    assert.equal(actual.stateInit.ok, true, `default state initialization failed: ${JSON.stringify(actual.stateInit)}`);
    assert.equal(actual.defaultRoots.stateLockDirExists, true,
      'state initialization did not create the lock directory under the canonical temp root');
    assert.equal(typeof actual.reportedStateLockRoot, 'string');
    assert.equal(actual.reportedStateLockRoot, actual.defaultRoots.stateLockDir);
    assert.equal(actual.directSteering.ok, true, `default coordinator failed: ${JSON.stringify(actual.directSteering)}`);
    assert.equal(actual.directSteering.value.enabled, true);
    assert.equal(actual.defaultRoots.steeringRootExists, true);
    assert.equal(actual.defaultRoots.acpBridgeExists, true,
      `ACP did not create its bridge under the canonical temp root: ${JSON.stringify(actual.acpPrompt)}`);
    assert.equal(actual.defaultRoots.directBridgeCanonical, true);
    assert.equal(actual.acpPrompt.error?.message, 'provider request failed');
    assert.deepEqual(actual.calls, { fakeSessionCalls: 0, publisherFactoryCalls: 1 });

    assert.equal(actual.explicitStatePath.ok, false);
    assert.equal(actual.explicitStatePath.code, 'AGY_SESSION_STATE_PATH');
    assert.equal(actual.explicitSteeringRoot.ok, false);
    assert.equal(actual.explicitSteeringRoot.code, 'AGY_STEER_PATH');
    assert.equal(actual.explicitSteeringBridge.ok, false);
    assert.equal(actual.explicitSteeringBridge.code, 'AGY_STEER_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
