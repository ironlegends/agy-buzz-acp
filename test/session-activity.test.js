import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgySession } from '../src/agy-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (value) => { child.stdin.writes.push(value); return true; };
  child.stdin.end = () => {};
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

function emit(child, event) {
  child.stdout.emit('data', `${JSON.stringify(event)}\n`);
}

test('publishes only agent response deltas and bounded ACP activity', async () => {
  const child = fakeChild();
  const text = [];
  const activity = [];
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('question', (delta) => text.push(delta), (update) => activity.push(update));

  emit(child, { event: 'init', conversation_id: 'conversation-123' });
  emit(child, { event: 'step_update', step_update: {
    conversation_id: 'conversation-123', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello '
  } });
  emit(child, { event: 'step_update', step_update: {
    conversation_id: 'conversation-123', step_index: 2, state: 'ACTIVE', step_type: 'tool',
    tool_name: 'browser_search', text_delta: 'private tool output',
    tool_info: { parameters: { query: 'private' }, output: 'private' }
  } });
  emit(child, { event: 'step_update', step_update: {
    conversation_id: 'conversation-123', step_index: 2, state: 'DONE', step_type: 'tool',
    tool_name: 'browser_search', duration_seconds: 1.25
  } });
  emit(child, { event: 'step_update', step_update: {
    conversation_id: 'conversation-123', step_index: 3, state: 'DONE', step_type: 'system', text_delta: 'system detail'
  } });
  emit(child, { event: 'step_update', step_update: {
    conversation_id: 'conversation-123', step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'world'
  } });
  emit(child, { event: 'result', result: {
    conversation_id: 'conversation-123', status: 'SUCCESS', response: 'Hello world'
  } });

  assert.equal(await pending, 'Hello world');
  assert.deepEqual(text, ['Hello ', 'world']);
  assert.equal(activity[0].sessionUpdate, 'tool_call');
  assert.equal(activity[0].status, 'in_progress');
  const toolDone = activity.find((update) => update.toolName === 'browser_search' && update.status === 'completed');
  assert.equal(toolDone.sessionUpdate, 'tool_call_update');
  assert.equal(toolDone.title, 'browser_search');
  assert.equal(toolDone.durationSeconds, 1.25);
  assert.equal(activity.at(-1).toolName, 'agy_provider');
  assert.equal(activity.at(-1).status, 'completed');
  assert.equal(activity.some((update) => JSON.stringify(update).includes('private')), false);
  assert.ok(activity.every((update) => !Object.hasOwn(update, 'parameters') && !Object.hasOwn(update, 'output')));
});

test('poisons and stops a child after invalid JSON so late output cannot complete a later prompt', async () => {
  const child = fakeChild();
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('first', () => {});
  child.stdout.emit('data', '{invalid-json}\n');
  await assert.rejects(pending, /invalid stream JSON/);
  assert.equal(child.killCalls, 1);
  await assert.rejects(session.prompt('second', () => {}), /context lost|resume/i);
  child.stdout.emit('data', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'late' } }) + '\n');
  assert.equal(session.pending, null);
});

test('finishes an active tool as unconfirmed before completing the provider', async () => {
  const child = fakeChild();
  const activity = [];
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('tool', () => {}, (update) => activity.push(update));
  emit(child, { event: 'step_update', step_update: {
    step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file'
  } });
  emit(child, { event: 'result', result: { status: 'SUCCESS', response: 'answer' } });
  assert.equal(await pending, 'answer');
  const toolTerminal = activity.find((update) => update.toolName === 'view_file' && update.status === 'failed');
  assert.equal(toolTerminal.content[0].content.text, 'Final state unconfirmed');
  assert.equal(activity.at(-1).toolName, 'agy_provider');
  assert.equal(activity.at(-1).status, 'completed');
});

test('uses disjoint activity IDs for separate session instances', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const firstActivity = [];
  const secondActivity = [];
  const first = new AgySession({ spawnFn: () => firstChild });
  const second = new AgySession({ spawnFn: () => secondChild });
  const firstPending = first.prompt('first', () => {}, (update) => firstActivity.push(update));
  const secondPending = second.prompt('second', () => {}, (update) => secondActivity.push(update));
  emit(firstChild, { event: 'result', result: { status: 'SUCCESS', response: 'one' } });
  emit(secondChild, { event: 'result', result: { status: 'SUCCESS', response: 'two' } });
  await Promise.all([firstPending, secondPending]);
  assert.ok(firstActivity.length >= 2);
  assert.ok(secondActivity.length >= 2);
  assert.equal(new Set(firstActivity.map((update) => update.toolCallId)
    .filter((id) => id.startsWith('agy-'))
    .filter((id) => secondActivity.some((other) => other.toolCallId === id))).size, 0);
});

test('treats a legacy step without step_type as an agent response only', async () => {
  const child = fakeChild();
  const text = [];
  const activity = [];
  const session = new AgySession({ spawnFn: () => child });
  const pending = session.prompt('legacy', (delta) => text.push(delta), (update) => activity.push(update));
  emit(child, { event: 'step_update', step_update: { text_delta: 'legacy answer' } });
  emit(child, { event: 'result', result: { status: 'SUCCESS', response: 'legacy answer' } });
  assert.equal(await pending, 'legacy answer');
  assert.deepEqual(text, ['legacy answer']);
  assert.equal(activity.length, 2);
});

test('resumes only after a successful turn, then rejects a repeated init', async () => {
  const children = [];
  const activity = [];
  const invocations = [];
  const session = new AgySession({ spawnFn: (_command, args) => {
    const child = fakeChild();
    child.args = args;
    invocations.push(args);
    children.push(child);
    return child;
  } });
  const first = session.prompt('first', () => {}, (update) => activity.push(update));
  emit(children[0], { event: 'init', conversation_id: 'resume-123' });
  emit(children[0], { event: 'result', result: { conversation_id: 'resume-123', status: 'SUCCESS', response: 'first' } });
  assert.equal(await first, 'first');
  children[0].emit('close');

  const second = session.prompt('second', () => {}, (update) => activity.push(update));
  assert.equal(children.length, 2);
  assert.equal(invocations[1].at(-2), '--conversation');
  assert.equal(invocations[1].at(-1), 'resume-123');
  assert.equal(invocations[1].includes('--continue'), false);
  assert.equal(children[1].stdin.writes.length, 0);
  emit(children[1], { event: 'init', conversation_id: 'resume-123' });
  assert.equal(children[1].stdin.writes.length, 1);
  const repeatedInit = assert.rejects(second, /repeated init/i);
  emit(children[1], { event: 'init', conversation_id: 'resume-123' });
  await repeatedInit;
  assert.equal(children[1].stdin.writes.length, 1);
  assert.match(children[1].stdin.writes[0], /"second"/);
  assert.notEqual(activity[0].toolCallId, activity[2].toolCallId);
});

test('rejects a resumed child with a contradictory init without sending the prompt', async () => {
  const children = [];
  const session = new AgySession({ spawnFn: () => { const child = fakeChild(); children.push(child); return child; }, resumeTimeoutMs: 20 });
  const first = session.prompt('first', () => {});
  emit(children[0], { event: 'init', conversation_id: 'resume-123' });
  emit(children[0], { event: 'result', result: { conversation_id: 'resume-123', status: 'SUCCESS', response: 'first' } });
  await first;
  children[0].emit('close');

  const second = session.prompt('must not be sent', () => {});
  emit(children[1], { event: 'init', conversation_id: 'other-456' });
  await assert.rejects(second, /conversation id mismatch|resume/i);
  assert.equal(children[1].stdin.writes.length, 0);
  await assert.rejects(session.prompt('no downgrade', () => {}), /context lost|resume/i);
});

test('rejects resumed output that arrives before the matching init', async () => {
  const children = [];
  const session = new AgySession({ spawnFn: () => { const child = fakeChild(); children.push(child); return child; }, resumeTimeoutMs: 20 });
  const first = session.prompt('first', () => {});
  emit(children[0], { event: 'init', conversation_id: 'resume-123' });
  emit(children[0], { event: 'result', result: { conversation_id: 'resume-123', status: 'SUCCESS', response: 'first' } });
  await first;
  children[0].emit('close');

  const second = session.prompt('second', () => {});
  emit(children[1], { event: 'result', result: { conversation_id: 'resume-123', status: 'SUCCESS', response: 'wrong order' } });
  await assert.rejects(second, /matching init|resume/i);
  assert.equal(children[1].stdin.writes.length, 0);
});

test('fails closed when a resumed child never confirms its conversation', async () => {
  const children = [];
  const session = new AgySession({ spawnFn: () => { const child = fakeChild(); children.push(child); return child; }, resumeTimeoutMs: 10 });
  const first = session.prompt('first', () => {});
  emit(children[0], { event: 'init', conversation_id: 'resume-123' });
  emit(children[0], { event: 'result', result: { conversation_id: 'resume-123', status: 'SUCCESS', response: 'first' } });
  await first;
  children[0].emit('close');

  await assert.rejects(session.prompt('timeout', () => {}), /resume.*(init|conversation)|timeout/i);
  assert.equal(children[1].stdin.writes.length, 0);
  await assert.rejects(session.prompt('no downgrade', () => {}), /context lost|resume/i);
});

test('does not mark a turn resumable when SUCCESS omits the confirmed conversation id', async () => {
  const children = [];
  const session = new AgySession({ spawnFn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = session.prompt('first', () => {});
  emit(children[0], { event: 'init', conversation_id: 'resume-123' });
  emit(children[0], { event: 'result', result: { status: 'SUCCESS', response: 'first' } });
  assert.equal(await first, 'first');
  assert.equal(session.hasConfirmedConversation(), false);
  children[0].emit('close');
  await assert.rejects(session.prompt('must not downgrade', () => {}), /context lost|resume/i);
  assert.equal(children.length, 1);
});
