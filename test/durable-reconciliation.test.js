import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

const owner = 'ab'.repeat(32);
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const relay = 'wss://relay.example.test/socket';
const replyTo = 'f188a24b35cb6f2cc4cf4144f92eb01d25450441ef2afe7cea6075c4833af14f';
const prompt = [
  { type: 'text', text: '[Base]\nPlatform context.' },
  { type: 'text', text: `[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}\n[Buzz event: test]\nanswer` }
];

function wireReader(output) {
  let wire = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { wire += chunk; });
  return (id) => wire.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === id);
}

function diagnosticReader(diagnostics) {
  let text = '';
  diagnostics.setEncoding('utf8');
  diagnostics.on('data', (chunk) => { text += chunk; });
  return () => text;
}

async function durableHarness({ outboxFactory } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-reconcile-'));
  const state = new SessionState({ dir, owner, relay });
  // A real, enabled outbox: the fourth condition is the only one that survives a
  // restart, and a harness that disables it proves reconciliation in the one
  // configuration where that condition cannot refuse anything.
  const outbox = new DeliveryOutbox({ dir: await mkdtemp(join(tmpdir(), 'agy-reconcile-outbox-')), owner });
  const scope = await state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const find = wireReader(output);
  const readDiagnostics = diagnosticReader(diagnostics);
  const counters = { prompts: 0 };
  const trusted = [];
  const server = createAcpServer({
    input: new PassThrough(), output, diagnostics,
    sessionStateFactory: () => state,
    outboxFactory: outboxFactory ?? (() => outbox),
    identityFactory: async () => owner,
    sessionFactory: () => ({
      prompt: async () => { counters.prompts += 1; return 'answer'; },
      setTrustedConversation(value) { trusted.push(value); },
      getConversationId: () => 'conversation-1',
      hasConfirmedConversation: () => true,
      retireForCheckpoint: async () => 'conversation-1', retireForRecovery: async () => true,
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
    return find(id);
  };
  const record = async () => JSON.parse(await readFile(state.path(channelId), 'utf8'));
  const dispose = async () => {
    await server.close();
    await state.release();
    await rm(dir, { recursive: true, force: true });
  };
  return { state, scope, outbox, turn, counters, trusted, record, readDiagnostics, dispose };
}

test('a record left blocked by a dead turn is reconciled on the next prompt', async () => {
  const { state, scope, turn, counters, record, readDiagnostics, dispose } = await durableHarness();
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    assert.equal((await record()).conversationId, 'conversation-1');

    // Exactly what an idle-killed turn leaves behind: `invalidate` ran, `save` never did.
    await state.invalidate(scope);
    assert.equal((await record()).status, 'blocked');

    const resumed = await turn();
    assert.ok(resumed?.result, `expected the blocked record to be reconciled, got ${JSON.stringify(resumed)}`);
    assert.equal(resumed.result.stopReason, 'end_turn');
    assert.equal(counters.prompts, 2, 'the provider must run once the block is reconciled');
    assert.equal((await record()).status, 'ready');
    assert.equal((await record()).conversationId, 'conversation-1', 'reconciliation must resume, not discard');
    assert.match(readDiagnostics(), /session record reconciled channel=123e4567-e89b-12d3-a456-426614174000 conversation=conversation-1/);
  } finally { await dispose(); }
});

test('a record blocked before any conversation existed is removed rather than resumed', async () => {
  const { state, scope, turn, counters, trusted, record, readDiagnostics, dispose } = await durableHarness();
  try {
    // `invalidate` on a missing record writes `conversationId: null`: the turn died
    // before the provider ever produced one, so there is nothing to resume.
    await state.invalidate(scope);
    assert.equal((await record()).conversationId, null);

    const resumed = await turn();
    assert.ok(resumed?.result, `expected a fresh start, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 1);
    assert.deepEqual(trusted, [], 'no stale conversation may be bound as trusted');
    assert.equal((await record()).status, 'ready');
    assert.match(readDiagnostics(), /session record reconciled channel=[0-9a-f-]+ conversation=none/);
  } finally { await dispose(); }
});

test('reconciliation refuses a blocked record whose scope does not match', async () => {
  const { state, scope, turn, counters, dispose } = await durableHarness();
  try {
    await turn();
    await state.invalidate(scope);
    const blocked = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    blocked.scope = { ...blocked.scope, model: 'some-other-model' };
    await writeFile(state.path(channelId), `${JSON.stringify(blocked)}\n`, { encoding: 'utf8', mode: 0o600 });

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /scope mismatch/i);
    assert.equal(counters.prompts, 1, 'a foreign record must not be reconciled');
  } finally { await dispose(); }
});

async function steeringHarness({ durableState = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-reconcile-steer-'));
  // Steering is inspected before the durable state is scoped, so the ownership lock
  // is not held yet. Reconciliation of a bridge now requires this instance to take
  // that lock, which means the harness needs the real state and a real outbox.
  const state = new SessionState({ dir: await mkdtemp(join(tmpdir(), 'agy-steer-state-')), owner, relay });
  const outbox = new DeliveryOutbox({ dir: await mkdtemp(join(tmpdir(), 'agy-steer-outbox-')), owner });
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const find = wireReader(output);
  const readDiagnostics = diagnosticReader(diagnostics);
  const counters = { prompts: 0 };
  const gates = [];
  const errors = [];
  const server = createAcpServer({
    input: new PassThrough(), output, diagnostics,
    ...isolatedServerOptions({
      sessionFactory: () => ({
        prompt: async () => {
          counters.prompts += 1;
          const gate = gates.shift();
          if (gate) await gate;
          const error = errors.shift();
          if (error) throw error;
          return 'answer';
        },
        setSteeringCoordinator() {}, getConversationId: () => 'conversation-1',
        hasConfirmedConversation: () => true,
        setTrustedConversation() {},
        retireForCheckpoint: async () => 'conversation-1', retireForRecovery: async () => true,
        cancel() {}, close() {}
      }),
      sessionStateFactory: () => (durableState ? state : null),
      outboxFactory: () => outbox,
      identityFactory: async () => owner
    }),
    steeringSupported: true,
    steeringConfig: { hookConfigured: true, injectorExclusive: true, ownerId: owner, rootDir: dir }
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  let nextId = 2;
  const newSession = async () => {
    await server.handle({ jsonrpc: '2.0', id: nextId++, method: 'session/new', params: { cwd: dir } });
    return [...server.sessions.keys()].at(-1);
  };
  const sessionId = await newSession();
  const promptOn = (session) => {
    const id = nextId++;
    const settled = server.handle({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: session, prompt } });
    return { settled, read: () => find(id) };
  };
  const turn = async () => {
    const call = promptOn(sessionId);
    await call.settled;
    return call.read();
  };
  const bridgeDir = join(dir, `channel-${createHash('sha256').update(`${owner}:${channelId}`).digest('hex')}`);
  const setGuard = async (guardBlocked) => {
    const statePath = join(bridgeDir, 'state.json');
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    await writeFile(statePath, `${JSON.stringify({ ...current, guardBlocked })}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  const archives = async () => (await readdir(dir)).filter((name) => name.includes('-archived-'));
  const dispose = async () => {
    await server.close();
    await state.release();
    await rm(state.dir, { recursive: true, force: true });
    await rm(outbox.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  };
  return { state, outbox, cwd: dir, turn, promptOn, newSession, counters, gates, errors, setGuard, archives, bridgeDir, sessionId, readDiagnostics, dispose };
}

test('a bridge left blocked by a dead turn is archived and rebuilt on the next prompt', async () => {
  const { turn, counters, setGuard, archives, bridgeDir, readDiagnostics, dispose } = await steeringHarness();
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    await setGuard(true);

    const resumed = await turn();
    assert.ok(resumed?.result, `expected the blocked bridge to be reconciled, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 2, 'the provider must run once the bridge is reconciled');

    const archived = await archives();
    assert.equal(archived.length, 1, `expected exactly one archive, got ${JSON.stringify(archived)}`);
    const kept = JSON.parse(await readFile(join(dirname(bridgeDir), archived[0], 'state.json'), 'utf8'));
    assert.equal(kept.guardBlocked, true, 'the orphaned bridge must stay readable');
    assert.equal(JSON.parse(await readFile(join(bridgeDir, 'state.json'), 'utf8')).guardBlocked, false);
    assert.match(readDiagnostics(), /steering bridge reconciled channel=[0-9a-f-]+ archived=/);
  } finally { await dispose(); }
});

test('server rebuilds an explicitly retired mock session (real watchdog covered separately)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-reconcile-steer-timeout-'));
  const state = new SessionState({ dir: await mkdtemp(join(tmpdir(), 'agy-steer-timeout-state-')), owner, relay });
  const outbox = new DeliveryOutbox({ dir: await mkdtemp(join(tmpdir(), 'agy-steer-timeout-outbox-')), owner });
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const find = wireReader(output);
  const readDiagnostics = diagnosticReader(diagnostics);
  let prompts = 0;
  let steering = null;
  const server = createAcpServer({
    input: new PassThrough(), output, diagnostics,
    ...isolatedServerOptions({
      sessionFactory: () => ({
        async prompt() {
          prompts += 1;
          if (prompts === 1) {
            await steering.block('agy steering claim timed out');
            throw Object.assign(new Error('agy steering claim timed out'), { code: 'AGY_STEER_UNCERTAIN' });
          }
          return 'answer';
        },
        setSteeringCoordinator(value) { steering = value; },
        getConversationId: () => 'conversation-1', hasConfirmedConversation: () => true,
        setTrustedConversation() {}, retireForCheckpoint: async () => 'conversation-1', retireForRecovery: async () => true, cancel() {}, close() {}
      }),
      sessionStateFactory: () => state, outboxFactory: () => outbox, identityFactory: async () => owner
    }),
    steeringSupported: true,
    steeringConfig: { hookConfigured: true, injectorExclusive: true, ownerId: owner, rootDir: dir }
  });
  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } });
    const sessionId = [...server.sessions.keys()][0];
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt } });
    assert.ok(find(3).error, 'the steering timeout must fail the first turn');
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt } });
    assert.equal(find(4).result.stopReason, 'end_turn');
    assert.equal(prompts, 2);
    assert.match(readDiagnostics(), /steering bridge reconciled channel=[0-9a-f-]+ archived=/);
    assert.match(readDiagnostics(), /session record reconciled channel=[0-9a-f-]+ conversation=none/);
  } finally {
    await server.close(); await state.release();
    await rm(state.dir, { recursive: true, force: true }); await rm(outbox.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('a blocked bridge is not reconciled while another turn of this adapter holds the channel', async () => {
  const { turn, promptOn, newSession, counters, gates, setGuard, archives, sessionId, dispose } = await steeringHarness();
  try {
    await turn();

    // Hold one turn open on the channel, then block the bridge underneath it and let
    // a second session reach the guard. That block is not orphaned: refuse, keep it.
    let release;
    gates.push(new Promise((resolve) => { release = resolve; }));
    const held = promptOn(sessionId);
    const deadline = Date.now() + 5000;
    while (counters.prompts < 2) {
      assert.ok(Date.now() < deadline, `the held turn never reached the provider: ${JSON.stringify(held.read())}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await setGuard(true);

    const second = promptOn(await newSession());
    await second.settled;
    const refused = second.read();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /channel turn is busy/i);
    assert.deepEqual(await archives(), [], 'a bridge held by a live turn must not be archived');

    release();
    await held.settled;
    assert.ok(held.read()?.result, 'the held turn must still complete');
  } finally { await dispose(); }
});

test('a steering failure from this process recovers on the next prompt without respawn', async () => {
  const { turn, promptOn, counters, gates, errors, setGuard, archives, bridgeDir, sessionId, dispose } = await steeringHarness();
  try {
    assert.ok((await turn())?.result);
    let release;
    gates.push(new Promise((resolve) => { release = resolve; }));
    errors.push(Object.assign(new Error('agy steering claim timed out'), { code: 'AGY_STEER_UNCERTAIN' }));
    const failed = promptOn(sessionId);
    while (counters.prompts < 2) await new Promise((resolve) => setImmediate(resolve));
    await setGuard(true);
    release();
    await failed.settled;
    assert.ok(failed.read()?.error, 'the failed steering turn must surface an application error');
    assert.deepEqual(await archives(), [], 'reconciliation waits for the next prompt');

    const resumed = await turn();
    assert.ok(resumed?.result, `expected recovery without respawn, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 3);
    assert.equal((await archives()).length, 1);
    assert.equal(JSON.parse(await readFile(join(bridgeDir, 'state.json'), 'utf8')).guardBlocked, false);
  } finally { await dispose(); }
});

test('reconcile refuses to repair a record written for another scope', async () => {
  // Reachability note: through `session/prompt` this branch is unreachable, because
  // `load` raises the same mismatch before reconciliation is ever attempted. It is
  // exercised here directly so the guard cannot be removed unnoticed.
  const dir = await mkdtemp(join(tmpdir(), 'agy-reconcile-scope-'));
  const state = new SessionState({ dir, owner, relay });
  try {
    const scope = await state.scope({ channelId, cwd: dir, model: 'gemini-3.8-flash-high' });
    await state.save(scope, 'conversation-1');
    await state.invalidate(scope);
    const blocked = JSON.parse(await readFile(state.path(channelId), 'utf8'));
    blocked.scope = { ...blocked.scope, model: 'some-other-model' };
    await writeFile(state.path(channelId), `${JSON.stringify(blocked)}\n`, { encoding: 'utf8', mode: 0o600 });

    await assert.rejects(() => state.reconcile(scope), /scope mismatch/i);
    assert.equal(JSON.parse(await readFile(state.path(channelId), 'utf8')).status, 'blocked');
  } finally {
    await state.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a block from a settled turn is reconciled by the same process on the next prompt', async () => {
  const { state, turn, counters, record, readDiagnostics, dispose } = await durableHarness();
  try {
    const realSave = state.save.bind(state);
    let failures = 0;
    state.save = async (...args) => {
      if (failures === 0) { failures += 1; throw new Error('disk is full'); }
      return realSave(...args);
    };

    const first = await turn();
    assert.ok(first?.result, `the turn itself must still answer, got ${JSON.stringify(first)}`);
    assert.equal(failures, 1, 'the save failure must have been exercised');
    assert.equal((await record()).status, 'blocked', 'a failed save leaves the record blocked');

    // The first turn is now fully settled. The same process must behave like a fresh
    // process: re-read the durable record, apply the outbox/ownership guards, and
    // reconcile it instead of keeping a process-lifetime refusal in memory.
    const resumed = await turn();
    assert.ok(resumed?.result, `expected same-process reconciliation, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 2);
    assert.equal((await record()).status, 'ready');
    assert.match(readDiagnostics(), /session record reconciled channel=[0-9a-f-]+ conversation=none/);
  } finally { await dispose(); }
});

const disabledOutbox = () => ({ enabled: false, begin: async () => null, update: async () => null });

test('a disabled outbox refuses reconciliation instead of waving it through', async () => {
  // The outbox is off by default. When the only condition that survives a restart
  // cannot be evaluated, the block stays: a record blocked by a publication nobody
  // settled is indistinguishable, from here, from one blocked before any effect.
  const { state, scope, turn, counters, record, readDiagnostics, dispose } =
    await durableHarness({ outboxFactory: disabledOutbox });
  try {
    await turn();
    await state.invalidate(scope);

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /blocked after an incomplete turn/i);
    assert.equal(counters.prompts, 1, 'the provider must not run behind an unevaluable guard');
    assert.equal((await record()).status, 'blocked');
    assert.match(readDiagnostics(), /session record reconciliation refused channel=[0-9a-f-]+ reason=delivery outbox is disabled/);
  } finally { await dispose(); }
});

test('an unsettled delivery on the channel refuses reconciliation', async () => {
  const { state, scope, outbox, turn, counters, readDiagnostics, dispose } = await durableHarness();
  try {
    await turn();
    // `begin` without `update` is what an interrupted publication leaves: `list`
    // promotes it to `uncertain`, and nobody but an operator can settle it.
    await outbox.begin({ channelId, replyTo, content: 'answer' });
    await state.invalidate(scope);

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /blocked after an incomplete turn/i);
    assert.equal(counters.prompts, 1, 'an unsettled delivery must keep the block terminal');
    assert.match(readDiagnostics(), /session record reconciliation refused channel=[0-9a-f-]+ reason=an unsettled delivery is waiting/);
  } finally { await dispose(); }
});

test('an unsettled delivery on a different channel does not refuse this one', async () => {
  // Without this case a broken channel filter hides behind the fail-closed default:
  // every refusal would look correct because nothing would ever be reconciled.
  const { state, scope, outbox, turn, counters, record, dispose } = await durableHarness();
  try {
    await turn();
    await outbox.begin({ channelId: '99999999-e89b-12d3-a456-426614174000', replyTo, content: 'answer' });
    await state.invalidate(scope);

    const resumed = await turn();
    assert.ok(resumed?.result, `expected reconciliation, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 2);
    assert.equal((await record()).status, 'ready');
  } finally { await dispose(); }
});

test('an unreadable outbox refuses reconciliation', async () => {
  const { state, scope, turn, counters, readDiagnostics, dispose } = await durableHarness({
    outboxFactory: () => ({
      enabled: true, owner, begin: async () => null, update: async () => null,
      list: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }
    })
  });
  try {
    await turn();
    await state.invalidate(scope);

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.equal(counters.prompts, 1);
    assert.match(readDiagnostics(), /session record reconciliation refused channel=[0-9a-f-]+ reason=delivery outbox is unreadable/);
  } finally { await dispose(); }
});

test('a bridge is not archived without the durable channel ownership lock', async () => {
  // Steering is inspected before the state is scoped, so the lock is not held yet.
  // With durable state disabled it can never be held: two adapters could then be
  // on the same channel, and either could archive a bridge the other still uses.
  const { turn, counters, setGuard, archives, bridgeDir, readDiagnostics, dispose } =
    await steeringHarness({ durableState: false });
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    await setGuard(true);

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /steering is durably blocked/i);
    assert.equal(counters.prompts, 1, 'the provider must not run behind an unowned bridge');
    assert.deepEqual(await archives(), [], 'an unowned bridge must not be archived');
    assert.equal(JSON.parse(await readFile(join(bridgeDir, 'state.json'), 'utf8')).guardBlocked, true,
      'the blocked bridge must be left exactly as it was found');
    assert.match(readDiagnostics(), /steering reconciliation refused channel=[0-9a-f-]+ reason=durable session state is disabled/);
  } finally { await dispose(); }
});

test('a bridge is not archived when the channel ownership lock cannot be taken', async () => {
  // That a second adapter cannot take the lock is proven in session-state.test.js.
  // What is proven here is the wiring: a refused acquisition leaves the bridge in
  // place instead of archiving a bridge that another adapter may still be using.
  const { state, turn, counters, setGuard, archives, bridgeDir, readDiagnostics, dispose } = await steeringHarness();
  try {
    assert.equal((await turn()).result.stopReason, 'end_turn');
    await setGuard(true);
    state.ensureOwnership = async () => {
      throw Object.assign(new Error('agy session state is owned by another adapter'),
        { code: 'AGY_SESSION_STATE_BUSY' });
    };

    const refused = await turn();
    assert.ok(refused?.error, `expected refusal, got ${JSON.stringify(refused)}`);
    assert.match(refused.error.message, /steering is durably blocked/i);
    assert.equal(counters.prompts, 1);
    assert.deepEqual(await archives(), [], 'a bridge whose channel is owned elsewhere must not be archived');
    assert.equal(JSON.parse(await readFile(join(bridgeDir, 'state.json'), 'utf8')).guardBlocked, true);
    assert.match(readDiagnostics(), /steering reconciliation refused channel=[0-9a-f-]+ reason=the channel ownership lock is held elsewhere/);
  } finally { await dispose(); }
});

test('a bridge blocked by a settled turn of this process is reconciled on the next prompt', async () => {
  // Reserve 1 of the previous review: mutating `channelsWithLiveBlock.has` on the
  // steering path left the battery green, because the turn fails either way. Only
  // the bridge directory itself can disagree, so assert on the archive.
  const { state, turn, counters, setGuard, archives, bridgeDir, readDiagnostics, dispose } = await steeringHarness();
  try {
    // A turn that answered and then failed to save leaves durable state blocked.
    // Once that turn has settled, the next prompt may reconcile it in this process.
    const realSave = state.save.bind(state);
    let failures = 0;
    state.save = async (...args) => {
      if (failures === 0) { failures += 1; throw new Error('disk is full'); }
      return realSave(...args);
    };
    assert.ok((await turn())?.result, 'the turn itself must still answer');
    assert.equal(failures, 1, 'the save failure must have been exercised');
    await setGuard(true);

    const resumed = await turn();
    assert.ok(resumed?.result, `expected same-process steering reconciliation, got ${JSON.stringify(resumed)}`);
    assert.equal(counters.prompts, 2);
    assert.equal((await archives()).length, 1, 'the settled blocked bridge must be archived once');
    assert.equal(JSON.parse(await readFile(join(bridgeDir, 'state.json'), 'utf8')).guardBlocked, false);
    assert.match(readDiagnostics(), /steering bridge reconciled channel=[0-9a-f-]+ archived=/);
  } finally { await dispose(); }
});

for (const [code, reason] of [
  ['AGY_SESSION_STATE_PERMISSIONS', 'permissions are insufficient'],
  ['AGY_SESSION_STATE_LEGACY_LOCK', 'legacy channel lock'],
  ['AGY_SESSION_STATE_NATIVE_UNAVAILABLE', 'native channel locking is unavailable'],
  ['AGY_SESSION_STATE_UNSAFE_LOCK', 'lock path is unsafe'],
  ['AGY_SESSION_STATE_SCOPE', 'scope is invalid'],
  ['UNKNOWN', 'could not be established']
]) test(`steering refusal preserves ownership category ${code} without mutation`, async () => {
  const {state, turn, counters, setGuard, archives, bridgeDir, readDiagnostics, dispose}=await steeringHarness();
  try {
    await turn(); await setGuard(true);
    const before=await readFile(join(bridgeDir,'state.json'),'utf8');
    state.ensureOwnership=async()=>{throw Object.assign(new Error('private-error-path-must-not-escape'),{code});};
    const refused=await turn();
    assert.ok(refused.error); assert.equal(counters.prompts,1); assert.deepEqual(await archives(),[]);
    assert.equal(await readFile(join(bridgeDir,'state.json'),'utf8'),before);
    assert.ok(readDiagnostics().includes(reason));
    assert.equal(readDiagnostics().includes('private-error-path-must-not-escape'),false);
    assert.equal(readDiagnostics().includes('held elsewhere'),false);
  } finally {await dispose();}
});
