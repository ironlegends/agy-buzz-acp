import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';

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
          getConversationId: () => 'conversation-1', prompt: async () => 'answer', cancel() {}, close() {} };
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
  const server = createAcpServer({ input, output, diagnostics,
    sessionFactory: () => ({ prompt: async () => 'answer', cancel() {}, close() {} }),
    publisherFactory: () => ({ publish: async (message) => { publications.push(message); return { status: 'sent', eventId: 'ef'.repeat(32) }; } })
  });
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
  const server = createAcpServer({ input, output, diagnostics, sessionStateFactory: () => state,
    identityFactory: async () => owner,
    sessionFactory: () => ({ prompt: async () => 'answer', getConversationId: () => 'conversation-1', hasConfirmedConversation: () => false, cancel() {}, close() {} }),
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
    await server.close();
    const next = new SessionState({ dir, owner, relay: 'wss://relay.example.test' });
    try { await assert.rejects(next.load(scope), /blocked after an incomplete turn/); }
    finally { await next.release(); }
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
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
