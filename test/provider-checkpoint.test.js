import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgySession } from '../src/agy-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.endCalls = 0;
  child.stdin.end = () => { child.stdin.endCalls += 1; };
  child.stdin.writes = [];
  child.stdin.write = (value) => {
    child.stdin.writes.push(JSON.parse(value));
    return true;
  };
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

function emitEvent(child, event) {
  child.stdout.emit('data', `${JSON.stringify(event)}\n`);
}

async function completeConfirmedTurn(session, childOrChildren, conversationId = 'conv-1') {
  const turn = session.prompt('prompt', () => {});
  const child = Array.isArray(childOrChildren) ? childOrChildren[0] : childOrChildren;
  emitEvent(child, { event: 'init', conversation_id: conversationId });
  emitEvent(child, { event: 'result', result: {
    status: 'SUCCESS', conversation_id: conversationId, response: 'answer'
  } });
  return turn;
}

function deferredRetirement(session) {
  return Promise.resolve().then(() => session.retireForCheckpoint());
}

test('retires a completed provider before checkpoint and resumes with the same conversation', async () => {
  const children = [];
  const session = new AgySession({
    spawnFn: (...args) => {
      const child = fakeChild();
      child._agyArgs = args[1];
      children.push(child);
      return child;
    }
  });

  assert.equal(await completeConfirmedTurn(session, children), 'answer');
  const retirement = session.retireForCheckpoint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children[0].stdin.endCalls, 1);
  assert.equal(children[0].killCalls, 1);
  children[0].emit('close');

  assert.equal(await retirement, 'conv-1');
  assert.equal(session.resumeEligible, true);
  const next = session.prompt('next prompt', () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(children[1].stdin.writes, []);
  assert.deepEqual(children[1]._agyArgs?.slice(-2), ['--conversation', 'conv-1']);
  emitEvent(children[1], { event: 'init', conversation_id: 'conv-1' });
  assert.equal(children[1].stdin.writes.length, 1);
  emitEvent(children[1], { event: 'result', result: {
    status: 'SUCCESS', conversation_id: 'conv-1', response: 'resumed answer'
  } });
  assert.equal(await next, 'resumed answer');
  session.close();
});

test('fails closed when checkpoint is requested during an active turn', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const active = session.prompt('in flight', () => {});
  const activeFailure = assert.rejects(active, /context|retire|closed|input|cancelled/i);

  try {
    await assert.rejects(deferredRetirement(session), /active|pending|context/i);
    await activeFailure;
  } finally {
    session.cancel();
  }
  assert.equal(session.contextLost, true);
  assert.equal(session.resumeEligible, false);
  await assert.rejects(session.prompt('must stay blocked', () => {}), /context lost|resume/i);
});

test('fails closed when the successful turn has no confirmed conversation id', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const turn = session.prompt('missing id', () => {});
  emitEvent(child, { event: 'result', result: { status: 'SUCCESS', response: 'answer' } });
  assert.equal(await turn, 'answer');

  await assert.rejects(deferredRetirement(session), /confirmed conversation|context/i);
  assert.equal(session.contextLost, true);
  assert.equal(session.resumeEligible, false);
  await assert.rejects(session.prompt('must stay blocked', () => {}), /context lost|resume/i);
  session.close();
});

test('bounds a hung provider close and blocks future prompts', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child, retireTimeoutMs: 15 });
  const turn = completeConfirmedTurn(session, child);
  assert.equal(await turn, 'answer');

  const startedAt = Date.now();
  await assert.rejects(session.retireForCheckpoint(), /close|timeout|context/i);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(session.contextLost, true);
  assert.equal(session.resumeEligible, false);
  await assert.rejects(session.prompt('must stay blocked', () => {}), /context lost|resume/i);
  session.close();
});

test('accepts an already closed provider after a confirmed successful turn', async () => {
  const children = [];
  const session = new AgySession({
    spawnFn: (...args) => {
      const child = fakeChild();
      child._agyArgs = args[1];
      children.push(child);
      return child;
    }
  });
  const first = completeConfirmedTurn(session, children);
  assert.equal(await first, 'answer');
  children[0].emit('close');

  assert.equal(await session.retireForCheckpoint(), 'conv-1');
  assert.equal(session.contextLost, false);
  assert.equal(session.resumeEligible, true);
  session.close();
});
