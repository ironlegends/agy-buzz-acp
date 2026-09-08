import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgySession } from '../src/agy-session.js';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

const conversationId = 'conv-steering-1';
const channelId = '11111111-1111-4111-8111-111111111111';
const replyTo = 'a'.repeat(64);

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (value) => {
    child.stdin.writes.push(JSON.parse(value));
    return true;
  };
  child.stdin.end = () => {};
  child.killCalls = 0;
  child._agyClosed = false;
  child.on('close', () => { child._agyClosed = true; });
  child.kill = () => {
    child.killCalls += 1;
    queueMicrotask(() => {
      if (!child._agyClosed) child.emit('close');
    });
  };
  return child;
}

function emit(child, event) {
  child.stdout.emit('data', `${JSON.stringify(event)}\n`);
}

function emitUserInput(child, stepIndex = 0, id = conversationId) {
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: id, step_index: stepIndex
  } });
}

function fakeCoordinator({ snapshotErrorCount = 0, blockError = null } = {}) {
  const queue = [];
  let sequence = 1;
  let blocked = false;
  let snapshotCalls = 0;
  let observationCalls = 0;
  const snapshot = async () => {
    snapshotCalls += 1;
    if (snapshotCalls <= snapshotErrorCount) {
      throw blockError ?? Object.assign(new Error('snapshot contention'), { code: 'AGY_NATIVE_LOCK_BUSY' });
    }
    if (blocked) return { status: 'blocked', guardBlocked: true, activeSteerId: null, queue: [] };
    const active = queue.find((request) => request.claimed);
    return {
      status: active ? 'claimed' : queue.length ? 'queued' : 'injected',
      guardBlocked: queue.length > 0,
      activeSteerId: active?.steerId ?? null,
      queue: queue.map((request) => ({
        steerId: request.steerId,
        status: request.claimed ? 'awaiting_user_input' : 'queued'
      }))
    };
  };
  return {
    enabled: true,
    bridgeDir: 'C:\\private\\agy-steering',
    bridgeEnv: () => ({ AGY_STEER_BRIDGE_DIR: 'C:\\private\\agy-steering', AGY_STEER_BINDING: 'token' }),
    enqueue: async (text, { claimFloorStep }) => {
      if (blocked) throw Object.assign(new Error('blocked'), { code: 'AGY_STEER_BLOCKED' });
      const request = { steerId: `steer-${sequence}`, sequence, text, claimFloorStep, claimed: false };
      sequence += 1;
      queue.push(request);
      return { ...request, status: 'queued' };
    },
    observeUserInput: async ({ conversationId: observedConversationId, stepIndex }) => {
      observationCalls += 1;
      if (blocked || observedConversationId !== conversationId || queue.length === 0) {
        blocked = true;
        throw Object.assign(new Error('ambiguous'), { code: 'AGY_STEER_BLOCKED' });
      }
      const request = queue.shift();
      if (stepIndex <= request.claimFloorStep) {
        blocked = true;
        throw Object.assign(new Error('ambiguous'), { code: 'AGY_STEER_BLOCKED' });
      }
      return { outcome: 'injected', steerId: request.steerId, sequence: request.sequence, userInputStep: stepIndex };
    },
    claimFirst: () => {
      const request = queue.find((candidate) => !candidate.claimed);
      if (request) request.claimed = true;
    },
    snapshot,
    snapshotCount: () => snapshotCalls,
    observeCount: () => observationCalls,
    block: async () => {
      if (blockError) throw blockError;
      blocked = true;
      return true;
    },
    isBlocked: () => blocked
  };
}

function bootstrapCoordinator() {
  const coordinator = fakeCoordinator();
  coordinator.conversationBound = false;
  coordinator.boundConversationId = null;
  coordinator.bindConversation = async (id) => {
    coordinator.conversationBound = true;
    coordinator.boundConversationId = id;
  };
  const enqueue = coordinator.enqueue;
  coordinator.enqueue = async (...args) => {
    if (!coordinator.conversationBound) throw Object.assign(new Error('unbound'), { code: 'AGY_STEER_UNAVAILABLE' });
    return enqueue(...args);
  };
  return coordinator;
}

function transportPrompt(text = 'base') {
  return [
    { type: 'text', text: `[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}` },
    { type: 'text', text: `[Buzz event: @mention]\n${text}` }
  ];
}

function memoryServer({ sessionFactory, steeringFactory, publisherFactory } = {}) {
  const input = new PassThrough();
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
  const server = createAcpServer({ input, output, diagnostics,
    ...isolatedServerOptions({ sessionFactory, steeringFactory, publisherFactory })
  });
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1000;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`timed out; seen=${JSON.stringify(messages)}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { server, send, waitFor, messages, close: () => input.end() };
}

test('passes the private bridge to the child and publishes only the final corrected segment', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  let providerOptions;
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: (_command, _args, options) => {
    providerOptions = options;
    return child;
  } });
  const turn = session.prompt('base', () => {});
  assert.equal(providerOptions.env.AGY_STEER_BRIDGE_DIR, coordinator.bridgeDir);
  assert.equal(providerOptions.env.AGY_STEER_BINDING, 'token');
  assert.deepEqual(child.stdin.writes[0], { event: 'user', message: { content: 'base' } });
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 4
  } });

  const steer = session.steer('correct the answer');
  emitUserInput(child, 5);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'HOOK', conversation_id: conversationId, step_index: 6
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASEHOOK'
  } });

  assert.deepEqual(await steer, { outcome: 'injected', steerId: 'steer-1', sequence: 1, userInputStep: 5 });
  assert.equal(await turn, 'HOOK');
  assert.equal(child.killCalls, 0, 'steering must not cancel the provider');
  session.close();
});

test('accepts steering requested before init after the provider initial input', async () => {
  const child = fakeChild();
  const coordinator = bootstrapCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  const steer = session.steer('correct the answer');

  emit(child, { event: 'init', conversation_id: conversationId });
  await new Promise((resolve) => setImmediate(resolve));
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 4
  } });
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 5
  } });
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'B', conversation_id: conversationId, step_index: 6
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASEB'
  } });

  assert.deepEqual(await steer, { outcome: 'injected', steerId: 'steer-1', sequence: 1, userInputStep: 5 });
  assert.equal(await turn, 'B');
  session.close();
});

test('accepts a turn without steering when the capability is disabled', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const turn = session.prompt('base', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 4
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASE'
  } });

  assert.equal(await turn, 'BASE');
  session.close();
});

test('arms the initial input for each prompt on a reused child without steering', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const first = session.prompt('first', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'FIRST', conversation_id: conversationId, step_index: 4
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'FIRST'
  } });
  assert.equal(await first, 'FIRST');

  const second = session.prompt('second', () => {});
  emitUserInput(child, 5);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'SECOND', conversation_id: conversationId, step_index: 7
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'SECOND'
  } });

  assert.equal(await second, 'SECOND');
  assert.equal(child.stdin.writes.length, 2);
  session.close();
});

test('arms the initial input for each prompt on a reused child with steering enabled', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const first = session.prompt('first', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'FIRST', conversation_id: conversationId, step_index: 4
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'FIRST'
  } });
  assert.equal(await first, 'FIRST');

  const second = session.prompt('second', () => {});
  emitUserInput(child, 5);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE2', conversation_id: conversationId, step_index: 7
  } });
  const steer = session.steer('correct second turn');
  emitUserInput(child, 8);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'SECOND', conversation_id: conversationId, step_index: 9
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASE2SECOND'
  } });

  assert.equal((await steer).userInputStep, 8);
  assert.equal(await second, 'SECOND');
  session.close();
});

test('rejects a repeated init without masking or acknowledging the hook input', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 4
  } });
  const steer = session.steer('must not be acknowledged after repeated init');
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 6);
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASE'
  } });

  const repeatedInit = (error) => error.code === 'AGY_STEER_UNCERTAIN' && /repeated init/i.test(error.message);
  await assert.rejects(turn, repeatedInit);
  await assert.rejects(steer, repeatedInit);
  assert.equal(coordinator.observeCount(), 0, 'the hook input must not be acknowledged');
  assert.equal(coordinator.isBlocked(), true);
  session.close();
});

test('accepts a nonzero initial step on a resumed conversation before steering', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  session.setTrustedConversation(conversationId);
  const turn = session.prompt('base', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 7);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 8
  } });
  const steer = session.steer('correct after resume');
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 9
  } });
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'RESUMED', conversation_id: conversationId, step_index: 10
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASERESUMED'
  } });

  assert.equal((await steer).userInputStep, 9);
  assert.equal(await turn, 'RESUMED');
  session.close();
});

test('fails closed on a second unexpected provider user input', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});

  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.isBlocked(), false, 'the first provider user input belongs to the prompt');
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 3
  } });

  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true);
  session.close();
});

test('keeps multiple corrections FIFO and publishes the segment after the last one', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 1
  } });
  const first = session.steer('first correction');
  const second = session.steer('second correction');
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 2
  } });
  await new Promise((resolve) => setImmediate(resolve));
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'FIRST', conversation_id: conversationId, step_index: 3
  } });
  await new Promise((resolve) => setImmediate(resolve));
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 4
  } });
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'SECOND', conversation_id: conversationId, step_index: 5
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASEFIRSTSECOND'
  } });

  assert.equal((await first).steerId, 'steer-1');
  assert.equal((await second).steerId, 'steer-2');
  assert.equal(await turn, 'SECOND');
  session.close();
});

test('handles multiple corrections with provider cut after first injection without replay or kill fallback', async () => {
  let childInstances = 0;
  let providerPromptWrites = 0;
  let steeringInjections = 0;
  let currentChild = null;

  const coordinator = fakeCoordinator();
  const origObserve = coordinator.observeUserInput;
  coordinator.observeUserInput = async (...args) => {
    const result = await origObserve(...args);
    if (result?.outcome === 'injected') steeringInjections += 1;
    return result;
  };

  const session = new AgySession({
    steeringCoordinator: coordinator,
    spawnFn: () => {
      childInstances += 1;
      currentChild = fakeChild();
      const origWrite = currentChild.stdin.write;
      currentChild.stdin.write = (value) => {
        try {
          const parsed = JSON.parse(value);
          if (parsed.event === 'user') providerPromptWrites += 1;
        } catch {}
        return origWrite(value);
      };
      return currentChild;
    }
  });

  const turn = session.prompt('base prompt', () => {});
  assert.equal(childInstances, 1);
  assert.equal(providerPromptWrites, 1);

  emit(currentChild, { event: 'init', conversation_id: conversationId });
  emitUserInput(currentChild);
  emit(currentChild, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 1
  } });

  // Step 1: Queue two corrections during one prompt
  const first = session.steer('first correction');
  const second = session.steer('second correction');

  // Resolve the first correction with matching user_input
  emit(currentChild, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 2
  } });

  // First correction resolves as injected exactly once
  const firstResult = await first;
  assert.equal(firstResult.steerId, 'steer-1');
  assert.equal(steeringInjections, 1, 'first correction must be injected exactly once');

  // Second correction remains queued. Now emit provider close before the second matching user_input
  currentChild.emit('close');

  // Step 2: Assert in-memory steering boundary
  await assert.rejects(second, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true, 'fake coordinator must be blocked');
  assert.equal(steeringInjections, 1, 'second correction must not be injected');

  // Step 3: Assert no replay or cancellation fallback
  assert.equal(currentChild.killCalls, 0, 'child kill calls must remain 0');
  assert.equal(childInstances, 1, 'child instances must remain 1');
  assert.equal(providerPromptWrites, 1, 'provider prompt writes must remain 1');

  await assert.rejects(session.prompt('later prompt must fail', () => {}), /context lost|steering/i);
  assert.equal(childInstances, 1, 'no new child may be spawned for replay');
  assert.equal(providerPromptWrites, 1, 'no re-prompt may be sent');

  session.close();
});

test('blocks before error when a provider result arrives before steering consumption', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const steer = session.steer('must be consumed');
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASE'
  } });

  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  await assert.rejects(steer, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true);
  assert.equal(child.killCalls, 1);
  await assert.rejects(session.prompt('replay is forbidden', () => {}), /context lost|steering/i);
  session.close();
});

test('binds the first provider conversation before allowing a steer', async () => {
  const child = fakeChild();
  const coordinator = bootstrapCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.boundConversationId, conversationId);
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'BASE', conversation_id: conversationId, step_index: 1
  } });
  const steer = session.steer('first correction');
  emit(child, { event: 'step_update', step_update: {
    step_type: 'user_input', conversation_id: conversationId, step_index: 2
  } });
  emit(child, { event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'HOOK', conversation_id: conversationId, step_index: 3
  } });
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASEHOOK'
  } });
  assert.equal((await steer).outcome, 'injected');
  assert.equal(await turn, 'HOOK');
  session.close();
});

test('keeps a queued steer available past the model wait and times out only after claim', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator({ snapshotErrorCount: 2 });
  const session = new AgySession({ steeringCoordinator: coordinator, steeringTimeoutMs: 20, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  const steer = session.steer('must not wait forever');
  emitUserInput(child);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(coordinator.isBlocked(), false, 'queued steering must not expire while the provider turn is still running');
  coordinator.claimFirst();
  await assert.rejects(steer, /timed out/i);
  await assert.rejects(turn, /timed out/i);
  assert.equal(coordinator.isBlocked(), true);
  assert.equal(child.killCalls, 1);
  session.close();
});

test('keeps valid queued snapshots beyond the old budget and times out only after claim', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const session = new AgySession({ steeringCoordinator: coordinator, steeringTimeoutMs: 20, spawnFn: () => child });
    const turn = session.prompt('base', () => {});
    void turn.catch(() => {});
    emit(child, { event: 'init', conversation_id: conversationId });
    emitUserInput(child, 2);
    const steer = session.steer('claim must remain available while the provider runs');
    let settled = false;
    steer.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(10_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'a valid queued claim must survive the old pre-claim budget');
    assert.equal(coordinator.isBlocked(), false);

    coordinator.claimFirst();
    mock.timers.tick(25);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(21);
    await assert.rejects(steer, /timed out/i);
    await assert.rejects(turn, /timed out/i);
    assert.equal(coordinator.isBlocked(), true);
    session.close();
  } finally {
    mock.timers.reset();
  }
});

test('bounds permanent snapshot failures and cleans the claim watchdog', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator({ snapshotErrorCount: 10 });
  const session = new AgySession({ steeringCoordinator: coordinator, steeringTimeoutMs: 20, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  void turn.catch(() => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  const steer = session.steer('snapshot must recover or fail closed');
  emitUserInput(child);

  const steerOutcome = await Promise.race([
    steer.then(() => ({ type: 'resolved' }), (error) => ({ type: 'error', error })),
    new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 120))
  ]);
  if (steerOutcome.type === 'timeout') {
    session.close();
    assert.fail('snapshot watchdog did not fail closed within the bounded budget');
  } else {
    assert.equal(steerOutcome.type, 'error');
  }
  assert.equal(steerOutcome.type, 'error');
  assert.equal(steerOutcome.error.code, 'AGY_STEER_UNCERTAIN');
  assert.match(steerOutcome.error.message, /snapshot|uncertain/i);
  assert.deepEqual(steerOutcome.error.causeCodes, [
    'AGY_NATIVE_LOCK_BUSY', 'AGY_NATIVE_LOCK_BUSY', 'AGY_NATIVE_LOCK_BUSY'
  ]);
  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true);
  const snapshotCalls = coordinator.snapshotCount();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(coordinator.snapshotCount(), snapshotCalls, 'snapshot failures must not leave a polling loop alive');
  assert.equal(child.killCalls, 1);
  session.close();
});

test('surfaces a durable block failure and keeps the session closed to replay', async () => {
  const child = fakeChild();
  const blockError = Object.assign(new Error('disk block unavailable'), { code: 'EIO' });
  const coordinator = fakeCoordinator({ blockError });
  const session = new AgySession({ steeringCoordinator: coordinator, steeringTimeoutMs: 20, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  const steer = session.steer('block failure must remain uncertain');
  emitUserInput(child);
  await new Promise((resolve) => setTimeout(resolve, 30));
  coordinator.claimFirst();

  await assert.rejects(steer, (error) => error.code === 'AGY_STEER_UNCERTAIN' && /block|persist/i.test(error.message));
  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN' && /block|persist/i.test(error.message));
  assert.equal(coordinator.isBlocked(), false, 'the fake disk must remain visibly unblocked after the failed write');
  await assert.rejects(session.prompt('replay is forbidden', () => {}), /context lost|steering/i);
  session.close();
});

test('blocks before rejecting when a provider result arrives before init with steering pending', async () => {
  const child = fakeChild();
  const coordinator = bootstrapCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  const steer = session.steer('must bind before claiming');
  emit(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'BASE'
  } });

  const turnOutcome = await Promise.race([
    turn.then(() => ({ type: 'resolved' }), (error) => ({ type: 'error', code: error.code })),
    new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 80))
  ]);
  assert.deepEqual(turnOutcome, { type: 'error', code: 'AGY_STEER_UNCERTAIN' });
  await assert.rejects(steer, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true);
  session.close();
});

test('blocks before rejecting when the provider exits before init with steering pending', async () => {
  const child = fakeChild();
  const coordinator = bootstrapCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child });
  const turn = session.prompt('base', () => {});
  const steer = session.steer('must not wait on a dead provider');
  child.emit('close');

  await assert.rejects(turn, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  await assert.rejects(steer, (error) => error.code === 'AGY_STEER_UNCERTAIN');
  assert.equal(coordinator.isBlocked(), true);
  session.close();
});

test('provisions a bootstrap bridge before the first conversation id exists', async () => {
  let conversation = null;
  let receivedCoordinator = null;
  let factoryOptions = null;
  const coordinator = bootstrapCoordinator();
  const fakeSession = {
    prompt: async () => {
      assert.ok(receivedCoordinator, 'the provider session must receive steering before its first prompt');
      conversation = conversationId;
      await receivedCoordinator.bindConversation(conversationId);
      return 'answer';
    },
    setSteeringCoordinator: (value) => { receivedCoordinator = value; },
    getConversationId: () => conversation,
    hasConfirmedConversation: () => Boolean(conversation),
    retireForCheckpoint: async () => conversationId,
    close() {}
  };
  const app = memoryServer({
    sessionFactory: () => fakeSession,
    steeringFactory: async (options) => { factoryOptions = options; return coordinator; },
    publisherFactory: () => ({ publish: async () => ({ status: 'sent' }) })
  });
  try {
    app.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await app.waitFor((message) => message.id === 1);
    app.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await app.waitFor((message) => message.id === 2);
    app.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
      sessionId: created.result.sessionId, prompt: transportPrompt('first turn')
    } });
    const response = await app.waitFor((message) => message.id === 3);
    assert.equal(response.result.stopReason, 'end_turn');
    assert.equal(factoryOptions.conversationId.startsWith('pending-'), true);
    assert.equal(factoryOptions.channelId, channelId);
  } finally {
    await app.close();
  }
});

test('advertises and routes the ACP steering extension without accepting a new-turn outcome', async () => {
  let resolveSteer;
  let receivedSteerPrompt;
  let promptCalls = 0;
  const fakeSession = {
    prompt: async () => {
      promptCalls += 1;
      return new Promise(() => {});
    },
    steer: (prompt) => {
      receivedSteerPrompt = prompt;
      return new Promise((resolve) => { resolveSteer = resolve; });
    },
    getConversationId: () => conversationId,
    hasConfirmedConversation: () => true,
    setSteeringCoordinator: () => {},
    retireForCheckpoint: async () => conversationId,
    close() {}
  };
  const coordinator = fakeCoordinator();
  const app = memoryServer({
    sessionFactory: () => fakeSession,
    steeringFactory: async () => coordinator,
    publisherFactory: () => ({ publish: async () => ({ status: 'sent' }) })
  });
  try {
    app.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const init = await app.waitFor((message) => message.id === 1);
    assert.equal(init.result._meta.steering.supported, true);
    app.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await app.waitFor((message) => message.id === 2);
    const sessionId = created.result.sessionId;
    app.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
      sessionId, prompt: transportPrompt('active')
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCalls, 1);
    app.send({ jsonrpc: '2.0', id: 4, method: '_session/steering', params: {
      sessionId, prompt: [{ type: 'text', text: 'correct ' }, { type: 'text', text: 'now' }]
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedSteerPrompt, 'correct now');
    resolveSteer({ outcome: 'injected' });
    const response = await app.waitFor((message) => message.id === 4);
    assert.deepEqual(response.result, { outcome: 'injected' });
  } finally {
    await app.close();
  }
});

test('stops the provider before rejecting a turn after steering fails', async () => {
  const child = fakeChild();
  const timeline = [];
  child.kill = () => {
    child.killCalls += 1;
    timeline.push('stop');
    queueMicrotask(() => {
      timeline.push('close');
      child.emit('close');
    });
  };
  const coordinator = fakeCoordinator();
  coordinator.block = async () => { timeline.push('blocked'); return true; };
  coordinator.enqueue = async () => {
    throw Object.assign(new Error('queue failed'), { code: 'AGY_STEER_QUEUE_FAILED' });
  };
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child, retireTimeoutMs: 50 });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const rejection = turn.catch((error) => { timeline.push('turn-rejected'); return error; });
  const steer = session.steer('must stop after queue failure');
  const steerRejection = steer.catch((error) => { timeline.push('steer-rejected'); return error; });

  const steerError = await steerRejection;
  assert.match(steerError.message, /queued|queue/i);
  const error = await rejection;
  assert.equal(error.code, 'AGY_STEER_QUEUE_FAILED');
  assert.deepEqual(timeline, ['blocked', 'stop', 'close', 'steer-rejected', 'turn-rejected']);
  assert.equal(child.killCalls, 1);
  session.close();
});

test('reports retirement failure and stays blocked when the provider does not close', async () => {
  const child = fakeChild();
  child.kill = () => { child.killCalls += 1; };
  const coordinator = fakeCoordinator();
  let blockCalls = 0;
  coordinator.block = async () => { blockCalls += 1; return true; };
  coordinator.enqueue = async () => {
    throw Object.assign(new Error('queue failed'), { code: 'AGY_STEER_QUEUE_FAILED' });
  };
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child, retireTimeoutMs: 10 });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const steer = session.steer('must report retirement failure');

  const steerError = await steer.then(() => null, (error) => error);
  assert.match(steerError.message, /retirement|close|timeout/i);
  const error = await turn.then(() => null, (cause) => cause);
  assert.ok(error, 'the provider turn must reject');
  assert.match(error.message, /retirement|close|timeout/i);
  assert.equal(error.code, 'AGY_STEER_UNCERTAIN');
  assert.equal(blockCalls, 1);
  assert.equal(child.killCalls, 1);
  assert.equal(session.contextLost, true);
  assert.equal(session.resumeEligible, false);
  await assert.rejects(session.prompt('replay is forbidden', () => {}), /context lost|resume/i);
  session.close();
});

test('does not kill a provider that already closed before steering failure handling', async () => {
  const child = fakeChild();
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child, retireTimeoutMs: 50 });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const steer = session.steer('provider will close first');
  child.emit('close');

  await assert.rejects(steer, /steering|context/i);
  await assert.rejects(turn, /steering|context/i);
  assert.equal(child.killCalls, 0);
  assert.equal(session.contextLost, true);
  session.close();
});

test('waits for a real close after stdin EPIPE during steering failure', async () => {
  const child = fakeChild();
  child.kill = () => { child.killCalls += 1; };
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child, retireTimeoutMs: 50 });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const steer = session.steer('EPIPE must await close');
  let settled = false;
  const turnOutcome = turn.then(() => { settled = true; }, (error) => { settled = true; return error; });
  const steerOutcome = steer.then(() => null, (error) => error);

  child.stdin.emit('error', new Error('EPIPE'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'EPIPE must not reject ACP promises before close');
  assert.equal(child.killCalls, 1);

  child.emit('close');
  const [turnError, steerError] = await Promise.all([turnOutcome, steerOutcome]);
  assert.equal(turnError.code, 'AGY_STEER_UNCERTAIN');
  assert.equal(steerError.code, 'AGY_STEER_UNCERTAIN');
  assert.equal(child.killCalls, 1);
  session.close();
});

test('waits for a real close after provider error during steering failure', async () => {
  const child = fakeChild();
  child.kill = () => { child.killCalls += 1; };
  const coordinator = fakeCoordinator();
  const session = new AgySession({ steeringCoordinator: coordinator, spawnFn: () => child, retireTimeoutMs: 50 });
  const turn = session.prompt('base', () => {});
  emit(child, { event: 'init', conversation_id: conversationId });
  emitUserInput(child);
  const steer = session.steer('provider error must await close');
  let settled = false;
  const turnOutcome = turn.then(() => { settled = true; }, (error) => { settled = true; return error; });
  const steerOutcome = steer.then(() => null, (error) => error);

  child.emit('error', new Error('provider error'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'provider error must not reject ACP promises before close');
  assert.equal(child.killCalls, 1);

  child.emit('close');
  const [turnError, steerError] = await Promise.all([turnOutcome, steerOutcome]);
  assert.equal(turnError.code, 'AGY_STEER_UNCERTAIN');
  assert.equal(steerError.code, 'AGY_STEER_UNCERTAIN');
  assert.equal(child.killCalls, 1);
  session.close();
});
