import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions, scrubRuntimeEnvironment } from '../scripts/environment-support.js';

const channelId = '123e4567-e89b-12d3-a456-426614174000';
const replyTo = 'f188a24b35cb6f2cc4cf4144f92eb01d25450441ef2afe7cea6075c4833af14f';

function contextPrompt() {
  return [
    { type: 'text', text: '[Base]' },
    { type: 'text', text: `[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}` }
  ];
}

function makeOutput(messages) {
  return new Writable({
    write(chunk, _encoding, callback) {
      messages.push(JSON.parse(String(chunk)));
      callback();
    }
  });
}

async function makeApp({ sessionFactory, publisherFactory, outboxFactory, identityFactory, steeringFactory } = {}) {
  const messages = [];
  const input = new PassThrough();
  const app = createAcpServer({
    input,
    output: makeOutput(messages),
    diagnostics: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ...isolatedServerOptions({ sessionFactory, publisherFactory, outboxFactory, identityFactory, steeringFactory })
  });
  await app.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await app.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
  return { app, messages, sessionId: messages.find((message) => message.id === 2).result.sessionId };
}

function activityMessages(messages) {
  return messages.filter((message) => {
    const update = message.params?.update;
    return message.method === 'session/update' &&
      ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate);
  });
}

function fakeOutbox(recoveryId) {
  return {
    enabled: true,
    owner: '1'.repeat(64),
    begin: async () => recoveryId,
    update: async () => null
  };
}

test('relays provider activity separately and keeps delivery status out of final text', async () => {
  const published = [];
  const app = await makeApp({
    sessionFactory: () => ({
      prompt: async (_text, onText, onActivity) => {
        onText('Final response');
        onActivity({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'provider-activity',
          title: 'Provider activity',
          kind: 'other',
          status: 'completed',
          content: 'Provider detail'
        });
        return 'Final response';
      },
      cancel() {}
    }),
    publisherFactory: () => ({
      publish: async (request) => {
        published.push(request);
        return { status: 'sent', eventId: 'a'.repeat(64) };
      }
    }),
    outboxFactory: () => ({ enabled: false, begin: async () => null, update: async () => null })
  });

  await app.app.handle({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: app.sessionId, prompt: contextPrompt() }
  });

  const providerActivity = app.messages.find((message) => message.params?.update?.toolCallId === 'provider-activity');
  assert.deepEqual(providerActivity.params, {
    sessionId: app.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'provider-activity',
      title: 'Provider activity',
      kind: 'other',
      status: 'completed',
      content: 'Provider detail'
    }
  });
  assert.equal(published[0].content, 'Final response');
  assert.equal(app.messages.find((message) => message.id === 3).result.publication.status, 'sent');
  assert.equal(published[0].content.includes('Publication'), false);
});

test('emits one delivery activity lifecycle with a unique id for each turn', async () => {
  const app = await makeApp({
    sessionFactory: () => ({
      prompt: async (_text, onText) => {
        onText('Final response');
        return 'Final response';
      },
      cancel() {}
    }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'b'.repeat(64) }) }),
    outboxFactory: () => ({ enabled: false, begin: async () => null, update: async () => null })
  });

  for (const id of [3, 4]) {
    await app.app.handle({
      jsonrpc: '2.0', id, method: 'session/prompt',
      params: { sessionId: app.sessionId, prompt: contextPrompt() }
    });
  }

  const activities = activityMessages(app.messages);
  assert.equal(activities.length, 6);
  const firstTurn = activities.slice(0, 3).map((message) => message.params.update);
  const secondTurn = activities.slice(3).map((message) => message.params.update);
  assert.deepEqual(firstTurn.map((update) => update.title), [
    'Response produced', 'Publication in progress', 'Response sent'
  ]);
  assert.deepEqual(secondTurn.map((update) => update.title), [
    'Response produced', 'Publication in progress', 'Response sent'
  ]);
  assert.ok(firstTurn.every((update) => update.kind === 'other'));
  assert.ok(secondTurn.every((update) => update.kind === 'other'));
  assert.deepEqual(firstTurn.map((update) => update.status), [
    'pending', 'in_progress', 'completed'
  ]);
  assert.ok(firstTurn.every((update) => update.toolName === 'buzz_delivery'));
  assert.ok(firstTurn.every((update) => Array.isArray(update.content)));
  assert.deepEqual(firstTurn[1].content, [{ type: 'content', content: { type: 'text', text: 'Publication in progress' } }]);
  assert.equal(new Set(firstTurn.map((update) => update.toolCallId)).size, 1);
  assert.equal(new Set(secondTurn.map((update) => update.toolCallId)).size, 1);
  assert.notEqual(firstTurn[0].toolCallId, secondTurn[0].toolCallId);
});

test('reports outbox durability failure with a usable recovery id', async () => {
  let publisherCalls = 0;
  const app = await makeApp({
    sessionFactory: () => ({ prompt: async () => 'Final response', cancel() {} }),
    publisherFactory: () => ({ publish: async () => { publisherCalls += 1; return { status: 'sent' }; } }),
    outboxFactory: () => ({
      enabled: true,
      owner: '1'.repeat(64),
      begin: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
      update: async () => null
    })
  });
  await app.app.handle({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: app.sessionId, prompt: contextPrompt() }
  });
  const updates = activityMessages(app.messages).map((message) => message.params.update);
  const terminal = updates.at(-1);
  const publication = app.messages.find((message) => message.id === 3).result.publication;
  assert.match(terminal.title, /failed/i);
  assert.match(JSON.stringify(terminal.content), new RegExp(publication.recoveryId));
  assert.match(publication.recoveryId, /^mem_/);
  assert.equal(publication.status, 'failed-before-start');
  assert.equal(publisherCalls, 0);
});

test('reports uncertain delivery with its recovery id', async () => {
  const recoveryId = 'recovery-uncertain';
  const app = await makeApp({
    sessionFactory: () => ({ prompt: async () => 'Final response', cancel() {} }),
    publisherFactory: () => ({ publish: async () => ({ status: 'uncertain' }) }),
    outboxFactory: () => fakeOutbox(recoveryId)
  });
  await app.app.handle({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: app.sessionId, prompt: contextPrompt() }
  });
  const updates = activityMessages(app.messages).map((message) => message.params.update);
  const terminal = updates.at(-1);
  assert.match(terminal.title, /uncertain/i);
  assert.match(JSON.stringify(terminal.content), new RegExp(recoveryId));
  assert.equal(app.messages.find((message) => message.id === 3).result.publication.status, 'uncertain');
});

test('marks cancelled publication uncertain and emits its recovery id', async () => {
  let releasePublisher;
  let publisherStarted;
  const started = new Promise((resolve) => { publisherStarted = resolve; });
  const app = await makeApp({
    sessionFactory: () => ({
      prompt: async () => 'Final response',
      cancel() {}
    }),
    publisherFactory: () => ({
      publish: async (_request, signal) => new Promise((resolve) => {
        publisherStarted();
        releasePublisher = () => resolve({ status: 'uncertain', code: 'CANCELLED' });
        signal.addEventListener('abort', releasePublisher, { once: true });
      })
    }),
    outboxFactory: () => fakeOutbox('recovery-cancel')
  });

  const pending = app.app.handle({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: app.sessionId, prompt: contextPrompt() }
  });
  await publisherStarted;
  await app.app.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: app.sessionId } });
  releasePublisher?.();
  await pending;

  const updates = activityMessages(app.messages).map((message) => message.params.update);
  const terminal = updates.at(-1);
  assert.match(terminal.title, /uncertain/i);
  assert.match(JSON.stringify(terminal.content), /recovery-cancel/);
  const response = app.messages.find((message) => message.id === 3);
  assert.equal(response.result.stopReason, 'cancelled');
  assert.equal(response.result.publication.status, 'uncertain');
});

test('keeps non-persistent helper roots isolated from inherited runtime configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-test-env-inheritance-'));
  const sessionRoot = join(root, 'session-root');
  const steeringRoot = join(root, 'steering-root');
  await mkdir(sessionRoot);
  await mkdir(steeringRoot);
  await writeFile(join(sessionRoot, 'SENTINEL.txt'), 'synthetic sentinel\n', 'utf8');
  await writeFile(join(steeringRoot, 'SENTINEL.txt'), 'synthetic steering sentinel\n', 'utf8');
  const before = { session: await readdir(sessionRoot), steering: await readdir(steeringRoot) };
  const owner = 'ab'.repeat(32);
  const inherited = {
    AGY_SESSION_DIR: sessionRoot,
    AGY_SESSION_OWNER: owner,
    BUZZ_RELAY_URL: 'wss://relay.synthetic.invalid/socket',
    AGY_STEER_ROOT_DIR: steeringRoot,
    AGY_STEER_OWNER: owner,
    AGY_STEER_HOOK_CONFIGURED: '1',
    AGY_STEER_INJECTOR_EXCLUSIVE: '1'
  };
  Object.assign(process.env, inherited);
  let promptCalls = 0;
  let publisherCalls = 0;
  let steeringFactoryCalls = 0;
  const app = await makeApp({
    sessionFactory: () => ({
      prompt: async () => { promptCalls += 1; return 'synthetic answer'; },
      getConversationId: () => 'conversation-synthetic',
      hasConfirmedConversation: () => true,
      retireForCheckpoint: async () => 'conversation-synthetic',
      cancel() {},
      close() {}
    }),
    publisherFactory: () => ({
      publish: async () => { publisherCalls += 1; return { status: 'sent', eventId: 'cd'.repeat(32) }; }
    }),
    outboxFactory: () => ({ enabled: false, begin: async () => null, update: async () => null }),
    identityFactory: async () => owner,
    steeringFactory: async (options) => {
      steeringFactoryCalls += 1;
      assert.equal(options.channelId, channelId);
      return {
        enabled: true,
        enqueue: async () => ({ outcome: 'injected' }),
        observeUserInput: async () => ({ outcome: 'injected' }),
        snapshot: async () => ({ status: 'injected', guardBlocked: false, activeSteerId: null, queue: [] }),
        block: async () => true
      };
    }
  });

  let after;
  try {
    await app.app.handle({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: app.sessionId, prompt: contextPrompt() }
    });
    after = { session: await readdir(sessionRoot), steering: await readdir(steeringRoot) };
  } finally {
    await app.app.close();
    for (const name of Object.keys(inherited)) delete process.env[name];
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(promptCalls, 1, 'the fake provider should handle the turn');
  assert.equal(publisherCalls, 1, 'the fake publisher should handle the turn');
  assert.equal(steeringFactoryCalls, 1, 'the synthetic steering factory must remain enabled and be injected');
  assert.deepEqual(after, before,
    'non-persistent helper must not write inherited durable session or steering roots');
});

test('disables inherited steering when no synthetic factory is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-test-env-inheritance-no-steering-'));
  const sessionRoot = join(root, 'session-root');
  const steeringRoot = join(root, 'steering-root');
  await mkdir(sessionRoot);
  await mkdir(steeringRoot);
  await writeFile(join(sessionRoot, 'SENTINEL.txt'), 'synthetic sentinel\n', 'utf8');
  await writeFile(join(steeringRoot, 'SENTINEL.txt'), 'synthetic steering sentinel\n', 'utf8');
  const before = { session: await readdir(sessionRoot), steering: await readdir(steeringRoot) };
  const owner = 'cd'.repeat(32);
  const inherited = {
    AGY_SESSION_DIR: sessionRoot,
    AGY_SESSION_OWNER: owner,
    BUZZ_RELAY_URL: 'wss://relay.synthetic.invalid/socket',
    AGY_STEER_ROOT_DIR: steeringRoot,
    AGY_STEER_OWNER: owner,
    AGY_STEER_HOOK_CONFIGURED: '1',
    AGY_STEER_INJECTOR_EXCLUSIVE: '1'
  };
  Object.assign(process.env, inherited);
  const app = await makeApp({
    sessionFactory: () => ({
      prompt: async () => 'synthetic answer',
      getConversationId: () => 'conversation-synthetic',
      hasConfirmedConversation: () => true,
      retireForCheckpoint: async () => 'conversation-synthetic',
      cancel() {},
      close() {}
    }),
    publisherFactory: () => ({
      publish: async () => ({ status: 'sent', eventId: 'ef'.repeat(32) })
    }),
    outboxFactory: () => ({ enabled: false, begin: async () => null, update: async () => null }),
    identityFactory: async () => owner
  });

  let after;
  try {
    await app.app.handle({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: app.sessionId, prompt: contextPrompt() }
    });
    after = { session: await readdir(sessionRoot), steering: await readdir(steeringRoot) };
  } finally {
    await app.app.close();
    for (const name of Object.keys(inherited)) delete process.env[name];
    await rm(root, { recursive: true, force: true });
  }

  assert.deepEqual(after, before,
    'without a synthetic factory, inherited steering must remain disabled and write nothing');
});

test('scrubs AGY and BUZZ runtime variables case-insensitively', () => {
  const env = {
    AGY_SESSION_DIR: 'synthetic-session',
    agy_session_owner: 'synthetic-owner',
    BuZz_Relay_Url: 'wss://relay.synthetic.invalid/socket',
    Path: 'system-path',
    TEMP: 'system-temp'
  };

  scrubRuntimeEnvironment(env);

  assert.deepEqual(env, { Path: 'system-path', TEMP: 'system-temp' });
});
