import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

const owner = 'ab'.repeat(32);
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const relay = 'wss://relay.example.test/socket';
const replyTo = 'f188a24b35cb6f2cc4cf4144f92eb01d25450441ef2afe7cea6075c4833af14f';
const prompt = [
  { type: 'text', text: '[Base]\nPlatform context.' },
  { type: 'text', text: `[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}\n[Buzz event: test]\nanswer` }
];

async function durableHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-reread-'));
  const state = new SessionState({ dir, owner, relay });
  const scope = await state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
  const output = new PassThrough();
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  const counters = { prompts: 0 };
  const server = createAcpServer({
    input: new PassThrough(), output, diagnostics: new PassThrough(),
    sessionStateFactory: () => state,
    outboxFactory: () => ({ enabled: false, begin: async () => null, update: async () => null }),
    identityFactory: async () => owner,
    sessionFactory: () => ({
      prompt: async () => { counters.prompts += 1; return 'answer'; },
      setTrustedConversation() {},
      getConversationId: () => 'conversation-1',
      hasConfirmedConversation: () => true,
      retireForCheckpoint: async () => 'conversation-1',
      cancel() {}, close() {}
    }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'cd'.repeat(32) }) })
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
  const sessionId = [...server.sessions.keys()][0];
  let nextId = 3;
  const turn = async () => {
    const id = nextId++;
    await server.handle({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt } });
    return wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === id);
  };
  const dispose = async () => {
    await server.close();
    await state.release();
    await rm(dir, { recursive: true, force: true });
  };
  return { state, scope, turn, counters, dispose };
}

test('a record blocked by an incomplete turn still refuses the next turn of the same process', async () => {
  const { state, scope, turn, counters, dispose } = await durableHarness();
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    assert.equal(counters.prompts, 1);

    // Exactly what an idle-killed turn leaves behind: `invalidate` ran, `save` never did.
    await state.invalidate(scope);

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /blocked after an incomplete turn/i);
    assert.equal(counters.prompts, 1, 'the provider must not run on a blocked record');
  } finally { await dispose(); }
});

test('a repaired record is honoured without restarting the adapter', async () => {
  const { state, scope, turn, counters, dispose } = await durableHarness();
  try {
    await turn();
    await state.invalidate(scope);
    assert.match((await turn()).error.message, /blocked after an incomplete turn/i);

    // The repair an operator applies on disk while the pool keeps running.
    await state.save(scope, 'conversation-1');

    const resumed = await turn();
    assert.ok(resumed?.result, `expected the repaired record to be honoured, got ${JSON.stringify(resumed)}`);
    assert.equal(resumed.result.stopReason, 'end_turn');
    assert.equal(counters.prompts, 2, 'the provider must run again once the record is sound');
    assert.equal(JSON.parse(await readFile(state.path(channelId), 'utf8')).status, 'ready');
  } finally { await dispose(); }
});

async function steeringHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-reread-steer-'));
  const output = new PassThrough();
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  const counters = { prompts: 0 };
  const server = createAcpServer({
    input: new PassThrough(), output, diagnostics: new PassThrough(),
    ...isolatedServerOptions({
      sessionFactory: () => ({
        prompt: async () => { counters.prompts += 1; return 'answer'; },
        setSteeringCoordinator() {}, getConversationId: () => 'conversation-1',
        retireForCheckpoint: async () => 'conversation-1',
        cancel() {}, close() {}
      })
    }),
    steeringSupported: true,
    steeringConfig: { hookConfigured: true, injectorExclusive: true, ownerId: owner, rootDir: dir }
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
  const sessionId = [...server.sessions.keys()][0];
  let nextId = 3;
  const turn = async () => {
    const id = nextId++;
    await server.handle({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt } });
    return wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === id);
  };
  const bridgeKey = createHash('sha256').update(`${owner}:${channelId}`).digest('hex');
  const statePath = join(dir, `channel-${bridgeKey}`, 'state.json');
  const setGuard = async (guardBlocked) => {
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    await writeFile(statePath, `${JSON.stringify({ ...current, guardBlocked })}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  const dispose = async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { turn, counters, setGuard, dispose };
}

test('a repaired steering bridge is honoured without restarting the adapter', async () => {
  const { turn, counters, setGuard, dispose } = await steeringHarness();
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    assert.equal(counters.prompts, 1);

    await setGuard(true);
    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /steering is durably blocked/i);
    assert.equal(counters.prompts, 1, 'the provider must not run on a blocked bridge');

    await setGuard(false);
    const resumed = await turn();
    assert.ok(resumed?.result, `expected the repaired bridge to be honoured, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 2, 'the provider must run again once the bridge is sound');
  } finally { await dispose(); }
});
