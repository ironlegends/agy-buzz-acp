import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { SessionState } from '../src/session-state.js';

const owner = 'ab'.repeat(32);
const relay = 'wss://relay.example.test/socket';
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const replyTo = 'f188a24b35cb6f2cc4cf4144f92eb01d25450441ef2afe7cea6075c4833af14f';

function promptFor(body) {
  return [
    { type: 'text', text: `[Context]\nChannel: canary DM (#${channelId})\nThread root: ${replyTo}` },
    { type: 'text', text: body }
  ];
}

function captureOutput(output) {
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
  return messages;
}

async function startHarness({ retirementResult = (record) => record.recoveryResult ?? true, steering = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-cancel-recovery-'));
  const state = new SessionState({ dir: join(root, 'state'), owner, relay });
  const outbox = new DeliveryOutbox({ dir: join(root, 'outbox'), owner, relay });
  const steeringRoot = join(root, 'steering');
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const messages = captureOutput(output);
  const sessions = [];
  const server = createAcpServer({
    input,
    output,
    diagnostics,
    identityFactory: async () => owner,
    modelCatalogFactory: async () => [],
    outboxFactory: () => outbox,
    sessionStateFactory: () => state,
    sessionFactory: ({ sessionId }) => {
      const record = {
        sessionId,
        promptTexts: [],
        trustedConversations: [],
        recoveryRetirements: 0,
        closed: false,
        steering: null,
        nextPrompt: null,
        rejectPendingPrompt: null
      };
      sessions.push(record);
      return {
        setSteeringCoordinator(coordinator) {
          record.steering = coordinator;
        },
        setTrustedConversation(conversationId) {
          record.trustedConversations.push(conversationId);
          record.conversationId = conversationId;
        },
        getConversationId() {
          return record.conversationId ?? null;
        },
        hasConfirmedConversation: () => Boolean(record.conversationId),
        async prompt(text) {
          record.promptTexts.push(text);
          record.conversationId ??= `conversation-${sessions.indexOf(record) + 1}`;
          if (record.steering?.conversationBound === false) {
            await record.steering.bindConversation(record.conversationId);
          }
          const next = record.nextPrompt;
          record.nextPrompt = null;
          return next ? next(record) : `answer:${text}`;
        },
        async retireForCheckpoint() {
          return record.conversationId;
        },
        async retireForRecovery() {
          record.recoveryRetirements += 1;
          const result = await retirementResult(record);
          if (result === true) record.closed = true;
          return result;
        },
        cancel() {
          record.rejectPendingPrompt?.(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          record.rejectPendingPrompt = null;
        },
        close() {
          record.closed = true;
        }
      };
    },
    publisherFactory: () => ({
      publish: async () => ({ status: 'sent', eventId: 'cd'.repeat(32) })
    }),
    ...(steering ? {
      steeringSupported: true,
      steeringConfig: {
        hookConfigured: true,
        injectorExclusive: true,
        ownerId: owner,
        rootDir: steeringRoot
      }
    } : {})
  });

  let nextId = 1;
  const rpc = async (method, params) => {
    const id = nextId++;
    await server.handle({ jsonrpc: '2.0', id, method, params });
    return messages.find((message) => message.id === id);
  };
  const newSession = async (cwd = root) => {
    const response = await rpc('session/new', { cwd });
    assert.ok(response?.result?.sessionId, `session/new failed: ${JSON.stringify(response)}`);
    return response.result.sessionId;
  };
  const requestPrompt = (sessionId, body) => {
    const id = nextId++;
    const pending = server.handle({
      jsonrpc: '2.0', id, method: 'session/prompt',
      params: { sessionId, prompt: promptFor(body) }
    });
    return { pending, response: () => messages.find((message) => message.id === id) };
  };
  const prompt = async (sessionId, body) => {
    const request = requestPrompt(sessionId, body);
    await request.pending;
    return request.response();
  };
  const cancel = (sessionId) => server.handle({
    jsonrpc: '2.0', method: 'session/cancel', params: { sessionId }
  });
  const record = async () => JSON.parse(await readFile(state.path(channelId), 'utf8'));
  const dispose = async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  };

  await rpc('initialize', { protocolVersion: 1 });
  return { root, state, outbox, steeringRoot, server, sessions, newSession, requestPrompt, prompt, cancel, record, dispose };
}

function armCancellation(record) {
  let started;
  const startedPrompt = new Promise((resolve) => { started = resolve; });
  record.nextPrompt = () => new Promise((_, reject) => {
    record.rejectPendingPrompt = reject;
    started();
  });
  return startedPrompt;
}

test('a new ACP session recovers a settled explicitly cancelled turn from its prior checkpoint', async () => {
  const harness = await startHarness({ steering: true });
  try {
    const oldSessionId = await harness.newSession();
    const completed = await harness.prompt(oldSessionId, 'completed checkpoint');
    assert.equal(completed?.result?.stopReason, 'end_turn', JSON.stringify(completed));
    assert.equal((await harness.record()).conversationId, 'conversation-1');

    const oldSession = harness.sessions[0];
    const startedPrompt = armCancellation(oldSession);
    const interrupted = harness.requestPrompt(oldSessionId, 'prompt to cancel');
    await startedPrompt;

    const newSessionId = await harness.newSession();
    const concurrent = await harness.prompt(newSessionId, 'must wait for cancellation to settle');
    assert.ok(concurrent?.error, `an active old turn was bypassed: ${JSON.stringify(concurrent)}`);
    assert.equal(harness.sessions[1].promptTexts.length, 0);
    assert.equal(oldSession.recoveryRetirements, 0, 'an active provider must not be retired for transfer');

    await harness.cancel(oldSessionId);
    await interrupted.pending;
    assert.equal(interrupted.response()?.result?.stopReason, 'cancelled');
    assert.equal(harness.server.sessions.get(oldSessionId).explicitCancelSettled, true);
    assert.equal((await harness.record()).status, 'blocked');
    assert.equal(Object.hasOwn(await harness.record(), 'explicitCancelSettled'), false,
      'the cancellation proof must remain in memory only');

    const recovered = await harness.prompt(newSessionId, 'fresh post-cancel prompt');
    assert.equal(recovered?.result?.stopReason, 'end_turn', JSON.stringify(recovered));
    assert.deepEqual(harness.sessions[1].trustedConversations, ['conversation-1']);
    assert.equal(harness.sessions[1].promptTexts.length, 1, 'the cancelled prompt must not be replayed');
    assert.match(harness.sessions[1].promptTexts[0], /fresh post-cancel prompt/);
    assert.doesNotMatch(harness.sessions[1].promptTexts[0], /prompt to cancel/);
    assert.equal(oldSession.recoveryRetirements, 1);
    assert.equal((await harness.record()).status, 'ready');
    assert.equal((await harness.record()).conversationId, 'conversation-1');
    assert.deepEqual((await readdir(harness.steeringRoot)).filter((name) => name.includes('-archived-')), [],
      'a prior durable conversation keeps its existing steering bridge');

    const stale = await harness.prompt(oldSessionId, 'old ACP identity must stay stale');
    assert.ok(stale?.error, `cancelled ACP session reclaimed the channel: ${JSON.stringify(stale)}`);
    assert.equal(oldSession.promptTexts.length, 2);
    assert.equal(harness.server.sessions.get(oldSessionId).explicitCancelSettled, false,
      'a committed transfer consumes the one-turn cancellation proof');
  } finally {
    await harness.dispose();
  }
});

test('a first-turn cancel starts a fresh ACP conversation instead of inventing a resume ID', async () => {
  const harness = await startHarness({ steering: true });
  try {
    const oldSessionId = await harness.newSession();
    const oldSession = harness.sessions[0];
    const startedPrompt = armCancellation(oldSession);
    const interrupted = harness.requestPrompt(oldSessionId, 'first turn that is cancelled');
    await startedPrompt;
    await harness.cancel(oldSessionId);
    await interrupted.pending;
    assert.equal(interrupted.response()?.result?.stopReason, 'cancelled');
    assert.equal((await harness.record()).status, 'blocked');
    assert.equal((await harness.record()).conversationId, null);

    const newSessionId = await harness.newSession();
    const recovered = await harness.prompt(newSessionId, 'fresh prompt with no prior conversation');
    assert.equal(recovered?.result?.stopReason, 'end_turn', JSON.stringify(recovered));
    assert.deepEqual(harness.sessions[1].trustedConversations, [],
      'a cancelled first turn must not bind a guessed conversation identifier');
    assert.equal(harness.sessions[1].promptTexts.length, 1);
    assert.match(harness.sessions[1].promptTexts[0], /fresh prompt with no prior conversation/);
    assert.doesNotMatch(harness.sessions[1].promptTexts[0], /first turn that is cancelled/);
    assert.equal(oldSession.recoveryRetirements, 1);
    assert.equal((await harness.record()).status, 'ready');
    assert.equal((await harness.record()).conversationId, 'conversation-2');

    const bridgeName = `channel-${createHash('sha256').update(`${owner}:${channelId}`).digest('hex')}`;
    const archived = (await readdir(harness.steeringRoot)).filter((name) => name.startsWith(`${bridgeName}-archived-`));
    assert.equal(archived.length, 1, `expected the orphaned first-turn bridge to be archived: ${JSON.stringify(archived)}`);
    const archivedBinding = JSON.parse(await readFile(join(harness.steeringRoot, archived[0], 'binding.json'), 'utf8'));
    assert.equal(archivedBinding.conversationId, 'conversation-1', 'the old bridge binding must remain readable in its archive');
    const currentBinding = JSON.parse(await readFile(join(harness.steeringRoot, bridgeName, 'binding.json'), 'utf8'));
    assert.equal(currentBinding.conversationId, 'conversation-2', 'the fresh prompt must bind a fresh bridge');

    const stale = await harness.prompt(oldSessionId, 'old first-turn session must stay stale');
    assert.ok(stale?.error, `first-turn cancelled session reclaimed the channel: ${JSON.stringify(stale)}`);
    assert.equal(oldSession.promptTexts.length, 1);
  } finally {
    await harness.dispose();
  }
});

test('a blocked peer session without an explicit cancel cannot transfer or reconcile', async () => {
  const harness = await startHarness();
  try {
    const oldSessionId = await harness.newSession();
    const oldSession = harness.sessions[0];
    oldSession.nextPrompt = async () => { throw new Error('provider failed without a cancel request'); };
    const failed = await harness.prompt(oldSessionId, 'provider failure');
    assert.ok(failed?.error, `the simulated provider failure did not surface: ${JSON.stringify(failed)}`);
    assert.equal(harness.server.sessions.get(oldSessionId).needsReplacement, true);
    assert.equal(harness.server.sessions.get(oldSessionId).explicitCancelSettled, false);

    const contenderId = await harness.newSession();
    const refused = await harness.prompt(contenderId, 'must stay blocked');
    assert.equal(refused?.error?.message, 'agy channel session is already owned');
    assert.equal(harness.sessions[1].promptTexts.length, 0);
    assert.equal(oldSession.recoveryRetirements, 0);
    assert.equal((await harness.record()).status, 'blocked');
  } finally {
    await harness.dispose();
  }
});

test('a new ACP session keeps the old owner when retirement is unconfirmed and can retry after proof', async () => {
  const harness = await startHarness();
  try {
    const oldSessionId = await harness.newSession();
    assert.equal((await harness.prompt(oldSessionId, 'checkpoint')).result.stopReason, 'end_turn');
    const oldSession = harness.sessions[0];
    const startedPrompt = armCancellation(oldSession);
    const interrupted = harness.requestPrompt(oldSessionId, 'cancelled turn');
    await startedPrompt;
    await harness.cancel(oldSessionId);
    await interrupted.pending;
    assert.equal(interrupted.response()?.result?.stopReason, 'cancelled');

    const contenderId = await harness.newSession();
    oldSession.recoveryResult = false;
    const refused = await harness.prompt(contenderId, 'fresh prompt after unconfirmed retirement');
    assert.match(refused?.error?.message ?? '', /retirement could not be confirmed/i);
    assert.equal(harness.sessions[1].promptTexts.length, 0);
    assert.equal(oldSession.recoveryRetirements, 1);
    assert.equal(harness.server.sessions.get(oldSessionId).channelTransferInvalidated, false);
    assert.equal((await harness.record()).status, 'blocked');

    oldSession.recoveryResult = true;
    const recovered = await harness.prompt(contenderId, 'fresh prompt after confirmed retirement');
    assert.equal(recovered?.result?.stopReason, 'end_turn', JSON.stringify(recovered));
    assert.deepEqual(harness.sessions[1].trustedConversations, ['conversation-1']);
    assert.equal(oldSession.recoveryRetirements, 2);
  } finally {
    await harness.dispose();
  }
});

test('an unsettled outbox record prevents cancelled-session transfer before provider retirement', async () => {
  const harness = await startHarness();
  try {
    const oldSessionId = await harness.newSession();
    assert.equal((await harness.prompt(oldSessionId, 'checkpoint')).result.stopReason, 'end_turn');
    const oldSession = harness.sessions[0];
    const startedPrompt = armCancellation(oldSession);
    const interrupted = harness.requestPrompt(oldSessionId, 'cancelled turn');
    await startedPrompt;
    await harness.cancel(oldSessionId);
    await interrupted.pending;
    assert.equal(interrupted.response()?.result?.stopReason, 'cancelled');

    const before = await readFile(harness.state.path(channelId), 'utf8');
    await harness.outbox.begin({ channelId, replyTo, content: 'unsettled external delivery' });
    const contenderId = await harness.newSession();
    const refused = await harness.prompt(contenderId, 'fresh prompt must remain blocked');
    assert.match(refused?.error?.message ?? '', /blocked after an incomplete turn/i);
    assert.equal(harness.sessions[1].promptTexts.length, 0);
    assert.equal(oldSession.recoveryRetirements, 0);
    assert.equal(await readFile(harness.state.path(channelId), 'utf8'), before);
  } finally {
    await harness.dispose();
  }
});

test('scope mismatch refuses cancelled-session recovery before retiring its previous provider', async () => {
  const harness = await startHarness();
  const otherCwd = join(harness.root, 'other-cwd');
  try {
    await mkdir(otherCwd);
    const oldSessionId = await harness.newSession();
    assert.equal((await harness.prompt(oldSessionId, 'checkpoint')).result.stopReason, 'end_turn');
    const oldSession = harness.sessions[0];
    const startedPrompt = armCancellation(oldSession);
    const interrupted = harness.requestPrompt(oldSessionId, 'cancelled turn');
    await startedPrompt;
    await harness.cancel(oldSessionId);
    await interrupted.pending;
    assert.equal(interrupted.response()?.result?.stopReason, 'cancelled');

    const before = await readFile(harness.state.path(channelId), 'utf8');
    const contenderId = await harness.newSession(otherCwd);
    const refused = await harness.prompt(contenderId, 'must not bind another scope');
    assert.match(refused?.error?.message ?? '', /scope mismatch/i);
    assert.equal(harness.sessions[1].promptTexts.length, 0);
    assert.equal(oldSession.recoveryRetirements, 0);
    assert.equal(await readFile(harness.state.path(channelId), 'utf8'), before);
  } finally {
    await harness.dispose();
  }
});
