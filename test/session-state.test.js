import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';
import { BuzzPublisher } from '../src/buzz-publisher.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (value) => { child.stdin.writes.push(value); return true; };
  child.stdin.end = () => { child.stdin.ended = true; };
  child.kill = () => { child.killed = true; };
  return child;
}

const owner = 'ab'.repeat(32);
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const relay = 'wss://relay.example.test/socket?token=must-not-persist';
const replyTo = 'f188a24b35cb6f2cc4cf4144f92eb01d25450441ef2afe7cea6075c4833af14f';
const prompt = [
  { type: 'text', text: '[Base]\nPlatform context.' },
  { type: 'text', text: `[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}\n[Buzz event: test]\nanswer` }
];

async function configured() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-state-'));
  const state = new SessionState({ dir, owner, relay });
  const scope = await state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
  return { dir, state, scope };
}

test('state persistence is opt-in even when Buzz relay configuration exists', () => {
  const state = new SessionState({ relay: 'wss://relay.example.test' });
  assert.equal(state.enabled, false);
  assert.equal(state.configurationError, null);
});

test('rejects a session relay override that differs from the configured publisher relay', async () => {
  const { createConfiguredSessionState } = await import('../src/session-state.js');
  const state = createConfiguredSessionState({ AGY_SESSION_DIR: 'C:\\state', AGY_SESSION_OWNER: owner,
    AGY_RELAY_URL: 'wss://one.example', BUZZ_RELAY_URL: 'wss://two.example' });
  assert.match(state.configurationError, /must match/);
});

test('persists only a verified channel association and strips relay credentials', async () => {
  const { dir, state, scope } = await configured();
  try {
    await state.verifyIdentity(async () => owner);
    await state.save(scope, 'conversation-1');
    const raw = await readFile(state.path(channelId), 'utf8');
    assert.equal(raw.includes('must-not-persist'), false);
    assert.equal(raw.includes('prompt'), false);
    assert.equal(raw.includes('systemPrompt'), false);
    assert.deepEqual((await state.load(scope)).scope, scope);
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects a saved association whose scope changes', async () => {
  const { dir, state, scope } = await configured();
  try {
    await state.save(scope, 'conversation-1');
    await assert.rejects(state.load({ ...scope, model: 'other-model' }), /scope mismatch/);
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('keeps a ready association blocked after a later turn is interrupted', async () => {
  const { dir, state, scope } = await configured();
  try {
    await state.save(scope, 'conversation-1');
    await state.invalidate(scope);
    await assert.rejects(state.load(scope), /blocked after an incomplete turn/);
    const raw = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    assert.equal(raw.status, 'blocked');
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('writes a blocked marker even when the first turn has no prior association', async () => {
  const { dir, state, scope } = await configured();
  try {
    assert.equal(await state.invalidate(scope), true);
    const raw = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    assert.equal(raw.status, 'blocked');
    assert.equal(raw.conversationId, null);
    await assert.rejects(state.load(scope), /blocked after an incomplete turn/);
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('keeps distinct relay query scopes distinct without persisting the relay endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-relay-'));
  const first = new SessionState({ dir, owner, relay: 'wss://relay.example.test/socket?tenant=a' });
  const second = new SessionState({ dir, owner, relay: 'wss://relay.example.test/socket?tenant=b' });
  try {
    assert.notEqual(first.relay, second.relay);
    const scope = await first.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
    await first.save(scope, 'conversation-1');
    const raw = await readFile(first.path(channelId), 'utf8');
    assert.equal(raw.includes('relay.example.test'), false);
    assert.equal(raw.includes('tenant=a'), false);
  } finally { await first.release(); await second.release(); await rm(dir, { recursive: true, force: true }); }
});

test('fails closed on corrupted state', async () => {
  const { dir, state, scope } = await configured();
  try {
    await state.ensureOwnership(channelId);
    await writeFile(state.path(channelId), '{bad json', 'utf8');
    await assert.rejects(state.load(scope), /state is corrupted/);
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('allows only one live owner for a channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-state-lock-'));
  const first = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  const second = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  try {
    await first.ensureOwnership(channelId);
    await assert.rejects(second.ensureOwnership(channelId), /owned by another adapter/);
  } finally { await first.release(); await second.release(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects an unverified Buzz identity', async () => {
  const { dir, state } = await configured();
  try { await assert.rejects(state.verifyIdentity(async () => 'cd'.repeat(32)), /does not match/); }
  finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('restores a durable association only after a fully delivered turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-server-'));
  const sessions = [];
  const makeServer = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
    const server = createAcpServer({ input, output, diagnostics,
      identityFactory: async () => owner,
      sessionStateFactory: () => state,
      sessionFactory: () => {
        const session = { trusted: null, setTrustedConversation(id) { this.trusted = id; }, hasConfirmedConversation: () => true,
          getConversationId: () => 'conversation-1', retireForCheckpoint: async () => 'conversation-1',
          prompt: async () => 'answer', cancel() {}, close() {} };
        sessions.push(session);
        return session;
      },
      publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'ab'.repeat(32) }) })
    });
    return { server, input, output, diagnostics, state };
  };
  try {
    const first = makeServer();
    await first.server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await first.server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = 'ses_test';
    // session ids are generated, so retrieve it from the response stream.
    let data = '';
    first.output.setEncoding('utf8');
    first.output.on('data', (chunk) => { data += chunk; });
    await new Promise((resolve) => setImmediate(resolve));
    const created = JSON.parse(data.trim().split('\n').at(-1));
    await first.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt } });
    const savedScope = await first.state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
    assert.equal((await first.state.load(savedScope)).conversationId, 'conversation-1');
    await first.server.close();

    const second = makeServer();
    let secondData = '';
    second.output.setEncoding('utf8');
    second.output.on('data', (chunk) => { secondData += chunk; });
    await second.server.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: 1 } });
    await second.server.handle({ jsonrpc: '2.0', id: 5, method: 'session/new', params: { cwd: dir } });
    await new Promise((resolve) => setImmediate(resolve));
    const createdSecond = JSON.parse(secondData.trim().split('\n').at(-1));
    await second.server.handle({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: createdSecond.result.sessionId, prompt } });
    assert.equal(sessions.at(-1).trusted, 'conversation-1');
    await second.server.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('binds one ACP session to its first Buzz channel', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const publications = [];
  const server = createAcpServer({ input, output, diagnostics, ...isolatedServerOptions({
    sessionFactory: () => ({ prompt: async () => 'answer', cancel() {}, close() {} }),
    publisherFactory: () => ({ publish: async (message) => { publications.push(message); return { status: 'sent', eventId: 'ef'.repeat(32) }; } })
  }) });
  const channelB = '223e4567-e89b-12d3-a456-426614174000';
  const promptFor = (channel) => [{ type: 'text', text: '[Base]\nPlatform context.' },
    { type: 'text', text: `[Context]\nChannel: coordination (#${channel})\nThread root: ${replyTo}\n[Buzz event: test]` }];
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = [...server.sessions.keys()][0];
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: promptFor(channelId) } });
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt: promptFor(channelB) } });
    assert.equal(publications.length, 1);
  } finally { await server.close(); }
});

test('does not persist an unconfirmed terminal conversation after an orderly close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-unconfirmed-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  let promptCalls = 0;
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  const server = createAcpServer({ input, output, diagnostics, sessionStateFactory: () => state,
    identityFactory: async () => owner,
    sessionFactory: () => ({ prompt: async () => { promptCalls += 1; return 'answer'; }, getConversationId: () => 'conversation-1', hasConfirmedConversation: () => false, cancel() {}, close() {} }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'aa'.repeat(32) }) })
  });
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });
    const scope = await state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
    const raw = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    assert.equal(raw.status, 'blocked');
    assert.equal(raw.conversationId, null);
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    const nextResponse = wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 4);
    assert.ok(nextResponse?.error, `expected terminal error, got ${JSON.stringify(nextResponse)}`);
    assert.match(nextResponse.error.message, /blocked after an incomplete turn|state association/i);
    assert.equal(promptCalls, 1);
    assert.equal((JSON.parse(await readFile(state.path(channelId), 'utf8'))).status, 'blocked');
    await server.close();
    const next = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
    try { await assert.rejects(next.load(scope), /blocked after an incomplete turn/); }
    finally { await next.release(); }
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('terminally blocks an ACP entry after uncertain publication before the next external effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-uncertain-'));
  const outboxDir = await mkdtemp(join(tmpdir(), 'agy-session-outbox-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  const outbox = new DeliveryOutbox({ dir: outboxDir, owner, idFn: () => 'state-uncertain-1' });

  let publishAttempts = 0;
  let ambiguousEffects = 0;
  let promptCalls = 0;
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });

  const publisher = new BuzzPublisher({
    spawnFn: (_command, args) => {
      publishAttempts += 1;
      const child = fakeChild();
      child.spawnArgs = args;
      const origEnd = child.stdin.end;
      child.stdin.end = () => {
        origEnd();
        ambiguousEffects += 1;
        setImmediate(() => {
          child.emit('spawn');
          child.emit('close', 1);
        });
      };
      return child;
    }
  });

  const server = createAcpServer({
    input, output, diagnostics,
    sessionStateFactory: () => state,
    outboxFactory: () => outbox,
    identityFactory: async () => owner,
    sessionFactory: () => ({
      prompt: async () => { promptCalls += 1; return 'answer'; },
      getConversationId: () => 'conversation-1',
      hasConfirmedConversation: () => true,
      cancel() {}, close() {}
    }),
    publisherFactory: () => publisher
  });

  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];

    // First turn
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });

    // Step 2 assertions:
    const firstResponse = wire.trim().split('\n').map((line) => JSON.parse(line)).find((m) => m.id === 3);
    assert.ok(firstResponse, 'must produce response for id 3');
    assert.equal(firstResponse.result.publication.status, 'uncertain');
    assert.equal(firstResponse.result.publication.recoveryId, 'state-uncertain-1');

    assert.equal(promptCalls, 1, 'provider prompts counter must equal 1');
    assert.equal(publishAttempts, 1, 'publication attempts counter must equal 1');
    assert.equal(ambiguousEffects, 1, 'ambiguous effects counter must equal 1');

    const stateFile = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    assert.equal(stateFile.status, 'blocked');

    const outboxRecord = await outbox.get('state-uncertain-1');
    assert.ok(outboxRecord, 'outbox record must exist');
    assert.equal(outboxRecord.status, 'uncertain');

    // Step 3 assertions: second turn on same server
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    const next = wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 4);
    assert.ok(next?.error, `expected terminal error, got ${JSON.stringify(next)}`);
    assert.match(next.error.message, /blocked after an incomplete turn/i);
    assert.equal(promptCalls, 1, 'provider prompt must not rerun on second turn');
    assert.equal(publishAttempts, 1, 'publisher must not be called on second turn');
    assert.equal(ambiguousEffects, 1);
    assert.equal((JSON.parse(await readFile(state.path(channelId), 'utf8'))).status, 'blocked');

    // Simulated restart: new SessionState and new server instance
    await server.close();
    const restartedState = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
    const restartedOutbox = new DeliveryOutbox({ dir: outboxDir, owner });
    const scope = await restartedState.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
    await assert.rejects(restartedState.load(scope), /blocked/i);

    const restartedOutput = new PassThrough();
    let restartedWire = '';
    restartedOutput.setEncoding('utf8');
    restartedOutput.on('data', (chunk) => { restartedWire += chunk; });
    const restartedServer = createAcpServer({
      input: new PassThrough(), output: restartedOutput, diagnostics: new PassThrough(),
      sessionStateFactory: () => restartedState,
      outboxFactory: () => restartedOutbox,
      identityFactory: async () => owner,
      sessionFactory: () => ({
        prompt: async () => { promptCalls += 1; return 'answer'; },
        getConversationId: () => 'conversation-1', hasConfirmedConversation: () => true,
        cancel() {}, close() {}
      }),
      publisherFactory: () => publisher
    });

    try {
      await restartedServer.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await restartedServer.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
      const restartedSessionId = [...restartedServer.sessions.keys()][0];
      await restartedServer.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: restartedSessionId, prompt } });
      const restartedResp = restartedWire.trim().split('\n').map((line) => JSON.parse(line)).find((m) => m.id === 3);
      assert.ok(restartedResp?.error, 'prompt on restarted server must fail');
      assert.match(restartedResp.error.message, /blocked after an incomplete turn/i);

      assert.equal(promptCalls, 1, 'provider prompt must remain 1 after restart attempt');
      assert.equal(publishAttempts, 1, 'publish attempts must remain 1 after restart attempt');
      assert.equal(ambiguousEffects, 1, 'ambiguous effects must remain 1 after restart attempt');
    } finally {
      await restartedServer.close();
      await restartedState.release();
    }
  } finally {
    await server.close();
    await state.release();
    await rm(dir, { recursive: true, force: true });
    await rm(outboxDir, { recursive: true, force: true });
  }
});

test('terminally blocks an ACP entry after a provider error before the next external effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-provider-error-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  let promptCalls = 0;
  let publisherCalls = 0;
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  const server = createAcpServer({ input, output, diagnostics, sessionStateFactory: () => state,
    identityFactory: async () => owner,
    sessionFactory: () => ({
      prompt: async () => { promptCalls += 1; throw new Error('provider exploded'); },
      cancel() {}, close() {}
    }),
    publisherFactory: () => ({ publish: async () => { publisherCalls += 1; return { status: 'sent' }; } })
  });
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    const next = wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 4);
    assert.ok(next?.error, `expected terminal error, got ${JSON.stringify(next)}`);
    assert.match(next.error.message, /blocked after an incomplete turn/i);
    assert.equal(promptCalls, 1);
    assert.equal(publisherCalls, 0);
    assert.equal((JSON.parse(await readFile(state.path(channelId), 'utf8'))).status, 'blocked');
  } finally { await server.close(); await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('terminally blocks an ACP entry after cancellation before the next external effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-cancelled-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  let promptCalls = 0;
  let publisherCalls = 0;
  let rejectPrompt;
  let promptStartedResolve;
  const promptStarted = new Promise((resolve) => { promptStartedResolve = resolve; });
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  const server = createAcpServer({ input, output, diagnostics, sessionStateFactory: () => state,
    identityFactory: async () => owner,
    sessionFactory: () => ({
      prompt: async () => {
        promptCalls += 1;
        promptStartedResolve();
        return new Promise((resolve, reject) => { rejectPrompt = reject; });
      },
      cancel() { rejectPrompt?.(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); },
      close() {}
    }),
    publisherFactory: () => ({ publish: async () => { publisherCalls += 1; return { status: 'sent' }; } })
  });
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];
    const first = server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });
    await promptStarted;
    await server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    await first;
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    const next = wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 4);
    assert.ok(next?.error, `expected terminal error, got ${JSON.stringify(next)}`);
    assert.match(next.error.message, /blocked after an incomplete turn/i);
    assert.equal(promptCalls, 1);
    assert.equal(publisherCalls, 0);
    assert.equal((JSON.parse(await readFile(state.path(channelId), 'utf8'))).status, 'blocked');
  } finally { await server.close(); await state.release(); await rm(dir, { recursive: true, force: true }); }
});

test('reserves a session before asynchronous identity checks race', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-session-race-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const state = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
  let identityStarted;
  let releaseIdentity;
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  identityStarted = new Promise((resolve) => { setImmediate(resolve); });
  const server = createAcpServer({ input, output, diagnostics, sessionStateFactory: () => state,
    identityFactory: async () => { await identityStarted; await identityGate; return owner; },
    sessionFactory: () => ({ prompt: async () => 'answer', getConversationId: () => 'conversation-1', cancel() {}, close() {} }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'cd'.repeat(32) }) })
  });
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];
    const first = server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });
    await new Promise((resolve) => setImmediate(resolve));
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    releaseIdentity();
    await first;
    const messages = wire.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(messages.find((message) => message.id === 4).error.code, -32002);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
