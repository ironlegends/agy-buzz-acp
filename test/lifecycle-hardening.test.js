import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAcpServer } from '../src/acp-server.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { SessionState } from '../src/session-state.js';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';

const owner = 'ab'.repeat(32);
const relay = 'wss://relay.example.test/socket';
const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));
const lifecycleFixture = join(runtimeRoot, 'fixtures', 'lifecycle-crash-worker.mjs');

const channel = (hex) => `${hex.repeat(8)}-1111-4111-8111-${hex.repeat(12)}`;
const event = (hex) => hex.repeat(64);

function promptFor(channelId, replyTo, body = 'synthetic lifecycle request') {
  return [
    { type: 'text', text: `[Context]\nChannel: synthetic (#${channelId})\nThread root: ${replyTo}` },
    { type: 'text', text: body }
  ];
}

function fallbackPromptFor(channelId, replyTo, body = 'synthetic channel request') {
  return [
    { type: 'text', text: `<context>\nScope: channel\nChannel: synthetic (#${channelId})\nUse \`--reply-to ${replyTo}\` for the current reply.\n</context>` },
    { type: 'text', text: `<buzz-event>\nEvent ID: ${replyTo}\nChannel: synthetic (#${channelId})\nContent: ${body}\n</buzz-event>` }
  ];
}

function captureWire() {
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const messages = [];
  let buffer = '';
  output.setEncoding('utf8');
  diagnostics.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  return { output, diagnostics, messages };
}

async function startDurableServer({ root, sessionFactory, publisherFactory, steering = false, saveOverride } = {}) {
  const state = new SessionState({ dir: join(root, 'state'), owner, relay });
  if (saveOverride) state.save = saveOverride(state.save.bind(state));
  const outbox = new DeliveryOutbox({ dir: join(root, 'outbox'), owner });
  const input = new PassThrough();
  const wire = captureWire();
  const server = createAcpServer({
    input,
    output: wire.output,
    diagnostics: wire.diagnostics,
    sessionStateFactory: () => state,
    outboxFactory: () => outbox,
    identityFactory: async () => owner,
    modelCatalogFactory: async () => [],
    sessionFactory,
    publisherFactory,
    ...(steering ? {
      steeringSupported: true,
      steeringConfig: {
        hookConfigured: true,
        injectorExclusive: true,
        ownerId: owner,
        rootDir: join(root, 'steering')
      }
    } : {})
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  let nextId = 2;
  const newSession = async () => {
    const id = nextId++;
    await server.handle({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: root } });
    const response = wire.messages.find((message) => message.id === id);
    assert.ok(response?.result?.sessionId, `session/new failed: ${JSON.stringify(response)}`);
    return response.result.sessionId;
  };
  const prompt = async (sessionId, value) => {
    const id = nextId++;
    await server.handle({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: value } });
    return wire.messages.find((message) => message.id === id);
  };
  const close = async () => {
    await server.close();
    await state.release();
  };
  return { root, state, outbox, server, wire, newSession, prompt, close };
}

function recordingSessionFactory(records, { promptGate } = {}) {
  return ({ sessionId }) => {
    const index = records.length + 1;
    const record = {
      index,
      sessionId,
      conversationId: null,
      trusted: [],
      promptCalls: 0,
      retirementCalls: 0,
      closeCalls: 0
    };
    records.push(record);
    return {
      setTrustedConversation(value) {
        record.trusted.push(value);
        record.conversationId = value;
      },
      getConversationId: () => record.conversationId ?? `conversation-${index}`,
      hasConfirmedConversation: () => true,
      prompt: async () => {
        record.promptCalls += 1;
        if (promptGate) await promptGate(record);
        return `response-${index}`;
      },
      retireForCheckpoint: async () => {
        record.retirementCalls += 1;
        return record.conversationId ?? `conversation-${index}`;
      },
      cancel() {},
      close() { record.closeCalls += 1; }
    };
  };
}

async function readRecord(state, channelId) {
  return JSON.parse(await readFile(state.path(channelId), 'utf8'));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for lifecycle fixture state');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function fileText(path) {
  return readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

async function snapshotDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const result = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result[entry.name] = await snapshotDirectory(path);
    else result[entry.name] = await readFile(path);
  }
  return result;
}

function childLines(child) {
  const lines = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) lines.push(JSON.parse(line));
    }
  });
  return lines;
}

function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
}

function spawnLifecycleWorker(mode, root) {
  return spawn(process.execPath, [lifecycleFixture, mode, runtimeRoot, root], {
    cwd: runtimeRoot,
    env: isolatedChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

test('transfers ACP channel ownership only after sent publication and ready checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-transfer-'));
  const channelId = channel('1');
  const replyTo = event('a');
  const records = [];
  const publications = [];
  const harness = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(records),
    publisherFactory: () => ({
      publish: async (value) => {
        publications.push(value);
        return { status: 'sent', eventId: 'e'.repeat(64) };
      }
    })
  });
  try {
    const firstSessionId = await harness.newSession();
    const first = await harness.prompt(firstSessionId, promptFor(channelId, replyTo, 'first response'));
    assert.equal(first?.result?.stopReason, 'end_turn', JSON.stringify(first));
    assert.deepEqual(await readRecord(harness.state, channelId), {
      schemaVersion: 1,
      sessionScope: 'channel',
      status: 'ready',
      scope: {
        owner,
        relay: harness.state.relay,
        cwd: await harness.state.realpathFn(root),
        model: 'gemini-3.8-flash-high',
        channelId
      },
      conversationId: 'conversation-1',
      updatedAt: (await readRecord(harness.state, channelId)).updatedAt
    });
    assert.equal((await harness.outbox.list()).at(-1).status, 'sent');

    const secondSessionId = await harness.newSession();
    const second = await harness.prompt(secondSessionId, promptFor(channelId, replyTo, 'second response'));
    assert.equal(second?.result?.stopReason, 'end_turn', `safe transfer refused: ${JSON.stringify(second)}`);
    assert.equal(records.length, 2);
    assert.deepEqual(records[1].trusted, ['conversation-1']);
    assert.equal(records[1].retirementCalls, 1);
    assert.equal(publications.length, 2);
    assert.equal((await readRecord(harness.state, channelId)).status, 'ready');
    assert.equal((await readRecord(harness.state, channelId)).conversationId, 'conversation-1');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not transfer ACP ownership when sent publication lacks ready checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-unready-transfer-'));
  const channelId = channel('b');
  const replyTo = event('6');
  const records = [];
  const harness = await startDurableServer({
    root,
    saveOverride: () => async () => { throw new Error('synthetic ready checkpoint failure'); },
    sessionFactory: recordingSessionFactory(records),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'a'.repeat(64) }) })
  });
  try {
    const formerSessionId = await harness.newSession();
    const first = await harness.prompt(formerSessionId, promptFor(channelId, replyTo, 'sent but unready'));
    assert.equal(first?.result?.publication?.status, 'sent', JSON.stringify(first));
    assert.equal((await readRecord(harness.state, channelId)).status, 'blocked');
    assert.equal((await harness.outbox.list()).at(-1).status, 'sent');

    const contenderSessionId = await harness.newSession();
    const refused = await harness.prompt(contenderSessionId, promptFor(channelId, replyTo, 'must remain blocked'));
    assert.ok(refused?.error, `unready session transferred ownership: ${JSON.stringify(refused)}`);
    assert.equal(records[1].promptCalls, 0);
    assert.equal((await readRecord(harness.state, channelId)).status, 'blocked');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalidates the former ACP sessionId permanently after channel transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-old-session-'));
  const channelId = channel('2');
  const replyTo = event('b');
  const records = [];
  const harness = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(records),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'f'.repeat(64) }) })
  });
  try {
    const firstSessionId = await harness.newSession();
    assert.equal((await harness.prompt(firstSessionId, promptFor(channelId, replyTo))).result.stopReason, 'end_turn');
    const secondSessionId = await harness.newSession();
    const transferred = await harness.prompt(secondSessionId, promptFor(channelId, replyTo, 'transferred'));
    assert.equal(transferred?.result?.stopReason, 'end_turn', JSON.stringify(transferred));

    const former = await harness.prompt(firstSessionId, promptFor(channelId, replyTo, 'must remain invalid'));
    assert.ok(former?.error, `former session reclaimed channel: ${JSON.stringify(former)}`);
    assert.equal(records[0].promptCalls, 1, 'former session provider must never run again');
    assert.equal((await harness.prompt(secondSessionId, promptFor(channelId, replyTo, 'current owner'))).result.stopReason, 'end_turn');
    assert.equal(records[1].promptCalls, 2, 'current owner must retain channel authority');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('allows one new ACP session to win while a second new session is concurrent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-concurrent-'));
  const channelId = channel('3');
  const replyTo = event('c');
  const records = [];
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const gate = (record) => {
    if (record.index !== 1) return undefined;
    firstStarted();
    return new Promise((resolve) => { releaseFirst = resolve; });
  };
  const harness = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(records, { promptGate: gate }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'd'.repeat(64) }) })
  });
  try {
    const contenderA = await harness.newSession();
    const contenderB = await harness.newSession();
    const firstTurn = harness.prompt(contenderA, promptFor(channelId, replyTo, 'winner'));
    await firstStartedPromise;
    const secondTurn = await harness.prompt(contenderB, promptFor(channelId, replyTo, 'loser'));
    assert.ok(secondTurn?.error, `concurrent session was accepted: ${JSON.stringify(secondTurn)}`);
    assert.equal(records[1].promptCalls, 0, 'losing session must not call provider');
    releaseFirst();
    const firstResult = await firstTurn;
    assert.equal(firstResult?.result?.stopReason, 'end_turn', JSON.stringify(firstResult));
    assert.equal(records[0].promptCalls, 1);
  } finally {
    releaseFirst?.();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a live blocked turn as sole owner until its provider retires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-live-block-'));
  const channelId = channel('4');
  const replyTo = event('d');
  const records = [];
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const harness = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(records, {
      promptGate: (record) => {
        if (record.index === 1) {
          started();
          return new Promise((resolve) => { release = resolve; });
        }
        return undefined;
      }
    }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '1'.repeat(64) }) })
  });
  try {
    const firstSessionId = await harness.newSession();
    const firstTurn = harness.prompt(firstSessionId, promptFor(channelId, replyTo, 'held provider'));
    await startedPromise;
    const blockedBytes = await readFile(harness.state.path(channelId), 'utf8');
    assert.equal((await readRecord(harness.state, channelId)).status, 'blocked');

    const secondSessionId = await harness.newSession();
    const second = await harness.prompt(secondSessionId, promptFor(channelId, replyTo, 'must wait'));
    assert.ok(second?.error, `live provider was bypassed: ${JSON.stringify(second)}`);
    assert.equal(records[1].promptCalls, 0);
    assert.equal(await readFile(harness.state.path(channelId), 'utf8'), blockedBytes);

    release();
    const first = await firstTurn;
    assert.equal(first?.result?.stopReason, 'end_turn', JSON.stringify(first));
    assert.equal(records[0].promptCalls, 1);
    assert.equal(records[1].promptCalls, 0);
    assert.equal((await readRecord(harness.state, channelId)).status, 'ready');
  } finally {
    release?.();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not reconcile a blocked record after failed retirement without observed close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-retirement-proof-'));
  const channelId = channel('5');
  const replyTo = event('e');
  const blockedError = Object.assign(new Error('provider close was not observed'), {
    rpcMessage: 'agy provider retirement could not be confirmed'
  });
  let recordStatus = 'missing';
  let closeObserved = false;
  let reconcileCalls = 0;
  let providerCalls = 0;
  const scope = {
    owner,
    relay: 'relay-hash',
    cwd: root,
    model: 'gemini-3.8-flash-high',
    channelId
  };
  const state = {
    enabled: true,
    ownsChannel: () => true,
    verifyIdentity: async () => {},
    scope: async () => scope,
    load: async () => {
      if (recordStatus === 'blocked') throw Object.assign(new Error('agy session state is blocked after an incomplete turn'), {
        code: 'AGY_SESSION_STATE_BLOCKED',
        rpcMessage: 'agy session state is blocked after an incomplete turn'
      });
      if (recordStatus === 'ready') return { status: 'ready', conversationId: 'conversation-1' };
      return null;
    },
    invalidate: async () => { recordStatus = 'blocked'; },
    reconcile: async () => {
      reconcileCalls += 1;
      recordStatus = 'ready';
      return { reconciled: true, conversationId: 'conversation-1' };
    },
    stageCheckpoint: async () => {},
    save: async () => { recordStatus = 'ready'; },
    release: async () => {}
  };
  const sessionFactory = () => ({
    prompt: async () => { providerCalls += 1; return 'answer'; },
    getConversationId: () => 'conversation-1',
    hasConfirmedConversation: () => true,
    setTrustedConversation() {},
    retireForCheckpoint: async () => {
      if (!closeObserved) throw blockedError;
      return 'conversation-1';
    },
    retireForRecovery: async () => {
      if (!closeObserved) throw blockedError;
      return true;
    },
    close() {}
  });
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const messages = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  const server = createAcpServer({
    input: new PassThrough(),
    output,
    diagnostics,
    sessionStateFactory: () => state,
    outboxFactory: () => ({ enabled: true, list: async () => [], begin: async () => null, update: async () => null }),
    identityFactory: async () => owner,
    modelCatalogFactory: async () => [],
    sessionFactory,
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '2'.repeat(64) }) })
  });
  const request = async (id, method, params) => {
    await server.handle({ jsonrpc: '2.0', id, method, params });
    return messages.find((message) => message.id === id);
  };
  try {
    await request(1, 'initialize', { protocolVersion: 1 });
    const created = await request(2, 'session/new', { cwd: root });
    const sessionId = created.result.sessionId;
    const failed = await request(3, 'session/prompt', { sessionId, prompt: promptFor(channelId, replyTo, 'failed retirement') });
    assert.ok(failed?.error, `failed retirement unexpectedly succeeded: ${JSON.stringify(failed)}`);
    assert.equal(recordStatus, 'blocked');
    const refused = await request(4, 'session/prompt', { sessionId, prompt: promptFor(channelId, replyTo, 'must remain blocked') });
    assert.ok(refused?.error, `blocked recovery bypassed missing close proof: ${JSON.stringify(refused)}`);
    assert.equal(reconcileCalls, 0);
    assert.equal(providerCalls, 1);

    closeObserved = true;
    const recovered = await request(5, 'session/prompt', { sessionId, prompt: promptFor(channelId, replyTo, 'after observed close') });
    assert.equal(recovered?.result?.stopReason, 'end_turn', JSON.stringify(recovered));
    assert.equal(reconcileCalls, 1);
    assert.equal(providerCalls, 2);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a blocked record from a fresh parent when no provider death proof exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-unknown-'));
  const channelId = channel('6');
  const replyTo = event('f');
  const originalState = new SessionState({ dir: join(root, 'state'), owner, relay });
  const scope = await originalState.scope({ channelId, cwd: root, model: 'gemini-3.8-flash-high' });
  await originalState.invalidate(scope);
  const beforeState = await readFile(originalState.path(channelId), 'utf8');
  await originalState.release();
  const beforeOutbox = await snapshotDirectory(join(root, 'outbox'));
  let providerCalls = 0;
  let publisherCalls = 0;
  const harness = await startDurableServer({
    root,
    sessionFactory: () => ({
      prompt: async () => { providerCalls += 1; return 'must not run'; },
      getConversationId: () => 'conversation-new',
      hasConfirmedConversation: () => true,
      setTrustedConversation() {},
      retireForCheckpoint: async () => 'conversation-new',
      close() {}
    }),
    publisherFactory: () => ({
      publish: async () => { publisherCalls += 1; return { status: 'sent', eventId: '3'.repeat(64) }; }
    })
  });
  try {
    const sessionId = await harness.newSession();
    const refused = await harness.prompt(sessionId, promptFor(channelId, replyTo, 'fresh parent must refuse'));
    assert.ok(refused?.error, `fresh parent resumed unknown blocked state: ${JSON.stringify(refused)}`);
    assert.equal(providerCalls, 0);
    assert.equal(publisherCalls, 0);
    assert.equal(await readFile(harness.state.path(channelId), 'utf8'), beforeState);
    assert.deepEqual(await snapshotDirectory(join(root, 'outbox')), beforeOutbox);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a ready conversation after adapter restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-restart-'));
  const channelId = channel('7');
  const replyTo = event('1');
  const firstRecords = [];
  const first = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(firstRecords),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '4'.repeat(64) }) })
  });
  try {
    const sessionId = await first.newSession();
    assert.equal((await first.prompt(sessionId, promptFor(channelId, replyTo, 'persist ready'))).result.stopReason, 'end_turn');
    assert.equal((await readRecord(first.state, channelId)).status, 'ready');
  } finally {
    await first.close();
  }
  const secondRecords = [];
  const second = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(secondRecords),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '5'.repeat(64) }) })
  });
  try {
    const sessionId = await second.newSession();
    const resumed = await second.prompt(sessionId, promptFor(channelId, replyTo, 'restart accepted'));
    assert.equal(resumed?.result?.stopReason, 'end_turn', JSON.stringify(resumed));
    assert.deepEqual(secondRecords[0].trusted, ['conversation-1']);
    assert.equal(secondRecords[0].promptCalls, 1);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('uses channel authority for thread and fallback reply destinations equally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-destination-'));
  const channelId = channel('8');
  const threadRoot = event('2');
  const fallbackReply = event('3');
  const records = [];
  const publications = [];
  const harness = await startDurableServer({
    root,
    sessionFactory: recordingSessionFactory(records),
    publisherFactory: () => ({
      publish: async (value) => {
        publications.push(value);
        return { status: 'sent', eventId: '6'.repeat(64) };
      }
    })
  });
  try {
    const firstSessionId = await harness.newSession();
    assert.equal((await harness.prompt(firstSessionId, promptFor(channelId, threadRoot, 'thread turn'))).result.stopReason, 'end_turn');
    const secondSessionId = await harness.newSession();
    const transferred = await harness.prompt(secondSessionId, fallbackPromptFor(channelId, fallbackReply, 'fallback turn'));
    assert.equal(transferred?.result?.stopReason, 'end_turn', JSON.stringify(transferred));
    assert.equal(publications[0].replyTo, threadRoot);
    assert.equal(publications[1].replyTo, fallbackReply);
    assert.deepEqual(records[1].trusted, ['conversation-1']);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not archive a blocked steering bridge from a fresh parent without retirement proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-steering-unknown-'));
  const channelId = channel('9');
  const replyTo = event('4');
  const firstRecords = [];
  const first = await startDurableServer({
    root,
    steering: true,
    sessionFactory: recordingSessionFactory(firstRecords),
    saveOverride: () => async () => { throw new Error('synthetic checkpoint write failure'); },
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '7'.repeat(64) }) })
  });
  let bridgeDir;
  try {
    const sessionId = await first.newSession();
    const result = await first.prompt(sessionId, promptFor(channelId, replyTo, 'leave steering blocked'));
    assert.ok(result?.result, `first synthetic turn did not reach checkpoint failure: ${JSON.stringify(result)}`);
    assert.equal((await readRecord(first.state, channelId)).status, 'blocked');
    bridgeDir = join(root, 'steering', `channel-${createHash('sha256').update(`${owner}:${channelId}`).digest('hex')}`);
    const bridgeStatePath = join(bridgeDir, 'state.json');
    const bridgeState = JSON.parse(await readFile(bridgeStatePath, 'utf8'));
    bridgeState.guardBlocked = true;
    await writeFile(bridgeStatePath, `${JSON.stringify(bridgeState)}\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    await first.close();
  }
  const beforeState = await readFile(join(root, 'state', `${createHash('sha256').update(channelId).digest('hex')}.json`), 'utf8');
  const beforeBridgeState = await readFile(join(bridgeDir, 'state.json'), 'utf8');
  let providerCalls = 0;
  let publisherCalls = 0;
  const second = await startDurableServer({
    root,
    steering: true,
    sessionFactory: () => ({
      prompt: async () => { providerCalls += 1; return 'must not run'; },
      getConversationId: () => 'conversation-1',
      hasConfirmedConversation: () => true,
      setTrustedConversation() {},
      setSteeringCoordinator() {},
      retireForCheckpoint: async () => 'conversation-1',
      close() {}
    }),
    publisherFactory: () => ({
      publish: async () => { publisherCalls += 1; return { status: 'sent', eventId: '8'.repeat(64) }; }
    })
  });
  try {
    const sessionId = await second.newSession();
    const refused = await second.prompt(sessionId, promptFor(channelId, replyTo, 'unknown bridge must refuse'));
    assert.ok(refused?.error, `fresh parent archived and resumed bridge: ${JSON.stringify(refused)}`);
    assert.equal(providerCalls, 0);
    assert.equal(publisherCalls, 0);
    assert.equal(await readFile(join(root, 'state', `${createHash('sha256').update(channelId).digest('hex')}.json`), 'utf8'), beforeState);
    assert.equal(await readFile(join(bridgeDir, 'state.json'), 'utf8'), beforeBridgeState);
    assert.deepEqual((await readdir(join(root, 'steering'))).filter((name) => name.includes('-archived-')), []);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses blocked state after parent death even when survivor is not observable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-no-survivor-'));
  const channelId = channel('a');
  const replyTo = event('5');
  const state = new SessionState({ dir: join(root, 'state'), owner, relay });
  const scope = await state.scope({ channelId, cwd: root, model: 'gemini-3.8-flash-high' });
  await state.invalidate(scope);
  const before = await readFile(state.path(channelId), 'utf8');
  await state.release();
  const outboxBefore = await snapshotDirectory(join(root, 'outbox'));
  let providerCalls = 0;
  const harness = await startDurableServer({
    root,
    sessionFactory: () => ({
      prompt: async () => { providerCalls += 1; return 'must remain blocked'; },
      getConversationId: () => 'conversation-new',
      hasConfirmedConversation: () => true,
      setTrustedConversation() {},
      retireForCheckpoint: async () => 'conversation-new',
      close() {}
    }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: '9'.repeat(64) }) })
  });
  try {
    const sessionId = await harness.newSession();
    const refused = await harness.prompt(sessionId, promptFor(channelId, replyTo, 'no provider observable'));
    assert.ok(refused?.error, `absence was treated as proof of death: ${JSON.stringify(refused)}`);
    assert.equal(providerCalls, 0);
    assert.equal(await readFile(harness.state.path(channelId), 'utf8'), before);
    assert.deepEqual(await snapshotDirectory(join(root, 'outbox')), outboxBefore);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('parent death leaves direct synthetic provider alive until cooperative stop', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-lifecycle-child-survivor-'));
  const parent = spawnLifecycleWorker('parent', root);
  const lines = childLines(parent);
  let stderr = '';
  parent.stderr.setEncoding('utf8');
  parent.stderr.on('data', (chunk) => { stderr += chunk; });
  let heartbeatPath;
  let stopPath;
  let providerMeta;
  try {
    const blocked = await waitFor(() => lines.find((line) => line.kind === 'blocked'));
    heartbeatPath = blocked.heartbeatPath;
    stopPath = blocked.stopPath;
    providerMeta = JSON.parse(await readFile(blocked.providerMetaPath, 'utf8'));
    const beforeLines = (await readFile(heartbeatPath, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(blocked.parentPid, parent.pid);
    assert.equal(providerMeta.parentPid, parent.pid);
    assert.equal(typeof providerMeta.pid, 'number');

    assert.equal(parent.kill(), true, 'kill exact parent handle');
    await waitForChildClose(parent);
    const afterParentDeath = await waitFor(async () => {
      const count = (await readFile(heartbeatPath, 'utf8')).trim().split('\n').filter(Boolean).length;
      return count > beforeLines ? count : 0;
    });
    assert.ok(afterParentDeath > beforeLines);

    const beforeState = await readFile(join(root, 'state', `${createHash('sha256').update(blocked.channelId).digest('hex')}.json`), 'utf8');
    const beforeOutbox = await snapshotDirectory(join(root, 'outbox'));
    const resume = spawnLifecycleWorker('resume', root);
    const resumeLines = childLines(resume);
    let resumeStderr = '';
    resume.stderr.setEncoding('utf8');
    resume.stderr.on('data', (chunk) => { resumeStderr += chunk; });
    await waitForChildClose(resume);
    const result = resumeLines.find((line) => line.kind === 'resume-result');
    assert.ok(result, `resume worker produced no result; stdout=${JSON.stringify(resumeLines)} stderr=${resumeStderr}`);
    assert.ok(result.rpc?.error, `fresh worker resumed child-owned block: ${JSON.stringify(result)}`);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.publisherCalls, 0);
    assert.equal(await readFile(join(root, 'state', `${createHash('sha256').update(blocked.channelId).digest('hex')}.json`), 'utf8'), beforeState);
    assert.deepEqual(await snapshotDirectory(join(root, 'outbox')), beforeOutbox);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill();
      await waitForChildClose(parent);
    }
    if (stopPath) {
      await writeFile(stopPath, 'stop\n', { encoding: 'utf8', mode: 0o600 });
      await waitFor(async () => (await fileText(join(root, 'provider.stopped'))) !== null, { timeoutMs: 10000 });
    }
    if (stderr) assert.equal(stderr.includes('secret'), false);
    await rm(root, { recursive: true, force: true });
  }
});
