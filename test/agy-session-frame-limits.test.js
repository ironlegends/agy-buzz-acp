import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgySession } from '../src/agy-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; child.emit('close'); };
  return child;
}

test('a null provider event is rejected with a controlled error and the child is stopped', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', 'null\n');
  await assert.rejects(pending, /invalid stream event shape/);
  assert.equal(child.killCalls, 1);
  session.close();
});

test('an array-shaped provider event is rejected with a controlled error', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', '[1,2,3]\n');
  await assert.rejects(pending, /invalid stream event shape/);
  session.close();
});

test('a scalar-shaped provider event is rejected with a controlled error', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', '"just a string"\n');
  await assert.rejects(pending, /invalid stream event shape/);
  session.close();
});

test('an event object missing a string event field is rejected with a controlled error', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', `${JSON.stringify({ conversation_id: 'x' })}\n`);
  await assert.rejects(pending, /invalid stream event shape/);
  session.close();
});

test('an oversized single provider line is rejected without unbounded buffering', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child, frameLimits: { maxFrameBytes: 64 } });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1', padding: 'x'.repeat(1000) }) + '\n');
  await assert.rejects(pending, /byte limit/);
  session.close();
});

test('response text accumulation beyond the configured limit fails the turn with a controlled error', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child, frameLimits: { maxResponseBytes: 16 } });
  const chunks = [];
  const pending = session.prompt('hi', (delta) => chunks.push(delta));
  child.stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'conv-1', step_index: 0, step_type: 'agent_response', text_delta: '0123456789'
  } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'conv-1', step_index: 1, step_type: 'agent_response', text_delta: '0123456789'
  } }) + '\n');
  await assert.rejects(pending, /exceeded the size limit/);
  assert.equal(child.killCalls, 1);
  session.close();
});

test('deferred provider events beyond the configured count fail the turn with a controlled error', async () => {
  const child = fakeChild();
  const stallingCoordinator = {
    enabled: true,
    conversationBound: false,
    bindConversation: () => new Promise(() => {}),
    enqueue: async () => {},
    observeUserInput: async () => {},
    snapshot: async () => ({}),
    block: async () => {}
  };
  const session = new AgySession({ spawnFn: () => child, frameLimits: { maxDeferredEvents: 2 },
    steeringCoordinator: stallingCoordinator });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  for (let i = 0; i < 3; i += 1) {
    child.stdout.emit('data', JSON.stringify({ event: 'step_update', step_update: {
      conversation_id: 'conv-1', step_index: i, step_type: 'tool', tool_name: 'noop', state: 'ACTIVE'
    } }) + '\n');
  }
  await assert.rejects(pending, /deferred events exceeded the limit/);
  session.close();
});

test('deferred provider events beyond the aggregate byte budget fail the turn', async () => {
  const child = fakeChild();
  const stallingCoordinator = {
    enabled: true,
    conversationBound: false,
    bindConversation: () => new Promise(() => {}),
    enqueue: async () => {},
    observeUserInput: async () => {},
    snapshot: async () => ({}),
    block: async () => {}
  };
  const session = new AgySession({ spawnFn: () => child, frameLimits: { maxDeferredEvents: 10, maxDeferredBytes: 128 },
    steeringCoordinator: stallingCoordinator });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'conv-1', step_index: 0, step_type: 'tool', tool_name: 'x'.repeat(200), state: 'ACTIVE'
  } }) + '\n');
  await assert.rejects(pending, /deferred events exceeded the byte limit/);
  session.close();
});

test('provider stdout EOF with a partial line rejects the turn instead of leaving it pending', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', '{"event":"init","conversation_id":"conv-1"}\n');
  child.stdout.emit('data', '{"event":"result"');
  child.stdout.emit('end');
  await assert.rejects(pending, /incomplete|truncated/);
  session.close();
});

test('provider stdout EOF with invalid UTF-8 rejects with the UTF-8 diagnostic', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('hi', () => {});
  child.stdout.emit('data', Buffer.from([0x7b, 0xff]));
  child.stdout.emit('end');
  await assert.rejects(pending, /invalid UTF-8/i);
  session.close();
});

test('rejects non-positive frame limit configuration', () => {
  assert.throws(() => new AgySession({ frameLimits: { maxFrameBytes: 0 } }), TypeError);
  assert.throws(() => new AgySession({ frameLimits: { maxResponseBytes: -1 } }), TypeError);
  assert.throws(() => new AgySession({ frameLimits: { maxDeferredEvents: 0 } }), TypeError);
  assert.throws(() => new AgySession({ frameLimits: { maxDeferredBytes: 0 } }), TypeError);
});
