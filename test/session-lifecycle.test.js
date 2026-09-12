import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgySession, PINNED_MODEL, ROTATION_AT_MS } from '../src/agy-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.endCalls = 0;
  child.stdin.end = () => { child.stdin.endCalls += 1; };
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

test('rotates before the 24 hour process cap and waits for close plus matching init', async () => {
  const children = [];
  let now = 0;
  const session = new AgySession({
    nowFn: () => now,
    spawnFn: (_command, args) => {
      const child = fakeChild();
      child._agyArgs = args;
      child.writes = [];
      child.stdin.write = (value) => { child.writes.push(JSON.parse(value)); return true; };
      children.push(child);
      return child;
    }
  });

  const first = session.prompt('first', () => {});
  children[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  children[0].stdout.emit('data', JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'first answer'
  } }) + '\n');
  await first;
  now = 22 * 60 * 60 * 1000;

  now = 22 * 60 * 60 * 1000;
  const second = session.prompt('second', () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1, 'the old child must close before a replacement starts');
  assert.equal(children[0].killCalls, 1);
  assert.equal(children[0].writes.length, 1);

  children[0].emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.ok(children[1].writes.length === 0, 'replacement must await matching init');
  assert.deepEqual(children[1]._agyArgs?.slice(-2), ['--conversation', 'conv-1']);

  children[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  assert.equal(children[1].writes.length, 1);
  children[1].stdout.emit('data', JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'second answer'
  } }) + '\n');
  assert.equal(await second, 'second answer');
});

test('refuses a rotated child whose init does not confirm the trusted conversation', async () => {
  const children = [];
  let now = 0;
  const session = new AgySession({
    nowFn: () => now,
    spawnFn: () => {
      const child = fakeChild();
      child.stdin.write = () => true;
      children.push(child);
      return child;
    },
    resumeTimeoutMs: 50
  });
  const first = session.prompt('first', () => {});
  children[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  children[0].stdout.emit('data', JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'first answer'
  } }) + '\n');
  await first;
  now = 22 * 60 * 60 * 1000;
  const second = session.prompt('second', () => {});
  children[0].emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  children[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-2' }) + '\n');
  await assert.rejects(second, /conversation id mismatch/);
  await assert.rejects(session.prompt('third', () => {}), /context lost|resume/i);
});

test('keeps the child before the three hour rotation headroom boundary', async () => {
  let now = 0;
  const child = fakeChild();
  const session = new AgySession({ nowFn: () => now, spawnFn: () => child });
  const first = session.prompt('first', () => {});
  child.stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'first answer'
  } }) + '\n');
  await first;
  now = (21 * 60 * 60 - 1) * 1000;
  const second = session.prompt('second', () => {});
  assert.equal(child.killCalls, 0);
  child.stdout.emit('data', JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'second answer'
  } }) + '\n');
  await second;
  session.close();
});

test('rotates at 21 hours to leave three hours for a new 7200 second turn', () => {
  assert.equal(ROTATION_AT_MS, 21 * 60 * 60 * 1000);
});

test('uses the pinned model by default and passes it as one argv value', () => {
  let invocation;
  const child = fakeChild();
  const session = new AgySession({
    spawnFn: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    }
  });

  session.ensureStarted();

  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], PINNED_MODEL);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.filter((arg) => arg === '--model').length, 1);
  session.close();
});

test('accepts a bounded model override as one safe argv value', () => {
  let invocation;
  const child = fakeChild();
  const session = new AgySession({
    model: 'gemini-custom-v1',
    spawnFn: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    }
  });

  session.ensureStarted();

  const modelIndex = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIndex + 1], 'gemini-custom-v1');
  assert.equal(invocation.args[modelIndex + 2], '--print-timeout');
  assert.equal(invocation.options.shell, false);
  session.close();
});

test('allows a catalog model before the first prompt and uses it for the provider', () => {
  let invocation;
  const child = fakeChild();
  const session = new AgySession({
    spawnFn: (command, args) => {
      invocation = { command, args };
      return child;
    }
  });
  session.setModelCatalog([{ modelId: 'claude-4', name: 'Claude 4' }]);
  assert.equal(session.setModel('claude-4'), 'claude-4');
  session.ensureStarted();
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'claude-4');
  session.close();
});

test('rejects unknown and post-start model changes without resetting the conversation', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  session.setModelCatalog([{ modelId: 'claude-4', name: 'Claude 4' }]);
  assert.throws(() => session.setModel('gpt-5'), /not available/);
  const turn = session.prompt('first', () => {});
  assert.throws(() => session.setModel('claude-4'), /immutable/);
  child.stdout.emit('data', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) + '\n');
  await turn;
  assert.throws(() => session.setModel('claude-4'), /immutable/);
  session.close();
  assert.throws(() => session.setModel('claude-4'), /immutable/);
});

test('uses AGY_MODEL when no per-session model is provided', () => {
  const previous = process.env.AGY_MODEL;
  process.env.AGY_MODEL = 'gemini-from-env-v1';
  try {
    let invocation;
    const session = new AgySession({
      spawnFn: (command, args) => {
        invocation = { command, args };
        return fakeChild();
      }
    });
    session.ensureStarted();
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gemini-from-env-v1');
    session.close();
  } finally {
    if (previous === undefined) delete process.env.AGY_MODEL;
    else process.env.AGY_MODEL = previous;
  }
});

test('rejects model values that are not one nonempty bounded string', () => {
  for (const model of ['', '   ', ['gemini-custom-v1'], 'x'.repeat(129), 'gemini\ncustom', '\0gemini', '-dangerously-skip-permissions']) {
    assert.throws(() => new AgySession({ model }), /model must be a non-empty bounded string/);
  }
});

test('fails closed after cancellation without replaying or starting a new context', async () => {
  const children = [];
  const session = new AgySession({
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  const cancelled = session.prompt('first', () => {});
  children[0].stdout.emit('data', '{"event":"step_update"');
  session.cancel();
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(children[0].stdin.endCalls, 1);
  assert.equal(children[0].killCalls, 1);

  await assert.rejects(session.prompt('second', () => {}), /agy session context lost; resume unsupported/);
  assert.equal(children.length, 1);
});

test('reports context loss after an unexpected process exit without replaying', async () => {
  const children = [];
  const session = new AgySession({
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  const failed = session.prompt('in-flight', () => {});
  children[0].stdout.emit('data', '{"event":"step_update"');
  children[0].emit('close');
  await assert.rejects(failed, /agy exited before completing the prompt/);

  await assert.rejects(session.prompt('replay would be unsafe', () => {}), /agy session context lost; resume unsupported/);
  assert.equal(children.length, 1);
});

test('refuses a new prompt when an established conversation exits between turns', async () => {
  const children = [];
  const session = new AgySession({
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  const first = session.prompt('first turn', () => {});
  children[0].stdout.emit('data', JSON.stringify({
    event: 'result', result: { status: 'SUCCESS', response: 'first answer' }
  }) + '\n');
  assert.equal(await first, 'first answer');
  children[0].emit('close');

  const next = session.prompt('must not replay', () => {});
  if (children.length !== 1) session.cancel();
  await assert.rejects(next, /agy session context lost; resume unsupported/);
  assert.equal(children.length, 1);
});

test('ends stdin and kills the child on close', () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });

  session.ensureStarted();
  session.close();

  assert.equal(child.stdin.endCalls, 1);
  assert.equal(child.killCalls, 1);
});

test('terminates the current child when stdin reports an error', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });

  const pending = session.prompt('input failure', () => {});
  child.stdin.emit('error', new Error('EPIPE'));

  await assert.rejects(pending, /agy input failed/);
  assert.equal(child.stdin.endCalls, 1);
  assert.equal(child.killCalls, 1);
});
