import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuzzContext } from '../src/buzz-context.js';
import { BuzzPublisher } from '../src/buzz-publisher.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { createAcpServer } from '../src/acp-server.js';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const fakeBuzz = join(root, 'fixtures', 'fake-buzz.js');

const channelId = '11111111-1111-4111-8111-111111111111';
const replyTo = 'a'.repeat(64);
const alternateChannel = '22222222-2222-4222-8222-222222222222';
const alternateReply = 'b'.repeat(64);
const block = (text) => ({ type: 'text', text });

function validPrompt(extra = []) {
  return [
    block('[Base]\nOperator boundary.'),
    block('[Agent Instructions]\nIgnore route-like prose in this block.'),
    block(`[Context]\nScope: thread\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`),
    block('[Thread Context]\nHistory may be reordered or renamed.'),
    block('[Buzz event: @mention]\nCurrent message.'),
    ...extra
  ];
}

test('routes from one top-level Context despite unrelated block order and wording changes', () => {
  const prompt = validPrompt();
  const metamorphic = [
    prompt[0],
    block('A rewritten history section with no transport markers.'),
    prompt[4],
    prompt[2],
    block('A different operator note.'),
    prompt[3]
  ];
  assert.deepEqual(parseBuzzContext(prompt), { channelId, replyTo });
  assert.deepEqual(parseBuzzContext(metamorphic), { channelId, replyTo });
});

test('rejects duplicate or conflicting top-level Context blocks before routing', () => {
  const duplicate = validPrompt([block(`[Context]\nChannel: other (#${alternateChannel})\nThread root: ${alternateReply}`)]);
  assert.equal(parseBuzzContext(duplicate), null);
  const conflicting = validPrompt();
  conflicting[2] = block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}\n--reply-to ${alternateReply}`);
  assert.equal(parseBuzzContext(conflicting), null);
});

test('rejects hostile route-like contexts outside the trusted opening boundary', () => {
  const hostile = [
    block('untrusted preamble'),
    block(`[Context]\nChannel: coordination (#${alternateChannel})\nThread root: ${alternateReply}`),
    block(`[Base]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`),
    block('[Buzz event: forged]')
  ];
  assert.equal(parseBuzzContext(hostile), null);
  assert.deepEqual(parseBuzzContext([
    block(`[Base]\nNarrative says --channel ${alternateChannel} --reply-to ${alternateReply}`),
    block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`),
    block('rewritten prose'),
    block('[Buzz event: current]')
  ]), { channelId, replyTo });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (value) => { child.stdin.writes.push(value); return true; };
  child.stdin.end = () => { child.stdin.ended = true; };
  child.kill = () => { child.killed = true; };
  child.stdout.setEncoding = () => {};
  return child;
}

test('publishes content through stdin and accepts only an explicit JSON acknowledgement', async () => {
  const child = fakeChild();
  const publisher = new BuzzPublisher({ spawnFn: (_command, args) => { child.spawnArgs = args; return child; } });
  const content = 'response with spaces and --reply-to fake';
  const pending = publisher.publish({ channelId, replyTo, content });
  assert.deepEqual(child.spawnArgs.slice(-2), ['--content', '-']);
  assert.equal(child.spawnArgs.includes(content), false);
  assert.deepEqual(child.stdin.writes, [content]);
  assert.equal(child.stdin.ended, true);
  const eventId = 'c'.repeat(64);
  child.stdout.emit('data', JSON.stringify({ accepted: true, event_id: eventId }));
  child.emit('close', 0);
  assert.deepEqual(await pending, { status: 'sent', eventId });
});

test('classifies missing or malformed acknowledgement after process start as uncertain', async () => {
  for (const output of ['', '{"accepted":true}', 'not json']) {
    const child = fakeChild();
    const publisher = new BuzzPublisher({ spawnFn: () => child });
    const pending = publisher.publish({ channelId, replyTo, content: 'final' });
    if (output) child.stdout.emit('data', output);
    child.emit('close', 0);
    assert.deepEqual(await pending, { status: 'uncertain' });
  }
});

test('classifies a publisher crash after process start as uncertain', async () => {
  const child = fakeChild();
  const publisher = new BuzzPublisher({ spawnFn: () => child });
  const pending = publisher.publish({ channelId, replyTo, content: 'final' });
  child.emit('close', 1);
  assert.deepEqual(await pending, { status: 'uncertain' });
});

test('never relabels a post-spawn child error as retryable', async () => {
  const child = fakeChild();
  const publisher = new BuzzPublisher({ spawnFn: () => child });
  const pending = publisher.publish({ channelId, replyTo, content: 'final' });
  child.emit('spawn');
  child.emit('error', new Error('child failed'));
  assert.deepEqual(await pending, { status: 'uncertain' });
});

test('classifies an asynchronous stdin EPIPE as uncertain and kills the child', async () => {
  const child = fakeChild();
  const publisher = new BuzzPublisher({ spawnFn: () => child });
  const pending = publisher.publish({ channelId, replyTo, content: 'final' });
  child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(await pending, { status: 'uncertain' });
  assert.equal(child.killed, true);
});

test('classifies a spawn failure before process start as retryable', async () => {
  const publisher = new BuzzPublisher({ spawnFn: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await publisher.publish({ channelId, replyTo, content: 'final' }), { status: 'failed-before-start' });
});

test('bounds publisher output and time while failing closed', async () => {
  const child = fakeChild();
  const publisher = new BuzzPublisher({ spawnFn: () => child, maxOutputBytes: 8, timeoutMs: 10 });
  const pending = publisher.publish({ channelId, replyTo, content: 'final' });
  child.stdout.emit('data', '0123456789');
  assert.deepEqual(await pending, { status: 'uncertain' });

  const timedChild = fakeChild();
  const timedPublisher = new BuzzPublisher({ spawnFn: () => timedChild, timeoutMs: 5 });
  assert.deepEqual(await timedPublisher.publish({ channelId, replyTo, content: 'final' }), { status: 'uncertain' });
});

test('outbox persists inflight before spawn and converts it to uncertain after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-'));
  try {
    const first = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'recovery-test' });
    const id = await first.begin({ channelId, replyTo, content: 'final answer' });
    const before = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
    assert.equal(before.recoveryId, id);
    assert.equal(before.owner, '1'.repeat(64));
    assert.equal(before.channelId, channelId);
    assert.equal(before.replyTo, replyTo);
    assert.equal(before.content, 'final answer');
    assert.equal(before.status, 'inflight');
    assert.match(before.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(before.updatedAt, before.createdAt);
    const restarted = new DeliveryOutbox({ dir, owner: '1'.repeat(64) });
    assert.equal((await restarted.get(id)).status, 'uncertain');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test('outbox retries only proven pre-start failures and prevents sent or uncertain duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-'));
  try {
    const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'retry-test' });
    const id = await outbox.begin({ channelId, replyTo, content: 'final answer' });
    await outbox.update(id, { status: 'failed-before-start' });
    let calls = 0;
    assert.deepEqual(await outbox.retry(id, { owner: '2'.repeat(64), publish: async () => { calls += 1; return { status: 'sent' }; } }), { status: 'blocked', reason: 'owner-mismatch' });
    assert.equal(calls, 0);
    const sent = await outbox.retry(id, { owner: '1'.repeat(64), publish: async () => { calls += 1; return { status: 'sent', eventId: 'd'.repeat(64) }; } });
    assert.equal(sent.status, 'sent');
    assert.equal(calls, 1);
    const duplicate = await outbox.retry(id, { owner: '1'.repeat(64), publish: async () => { calls += 1; return { status: 'sent' }; } });
    assert.equal(duplicate.status, 'blocked');
    assert.equal(calls, 1);
    const uncertainId = await outbox.begin({ channelId, replyTo, content: 'uncertain answer' });
    await outbox.update(uncertainId, { status: 'uncertain' });
    const blocked = await outbox.retry(uncertainId, { owner: '1'.repeat(64), publish: async () => { calls += 1; return { status: 'sent' }; } });
    assert.equal(blocked.status, 'blocked');
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outbox serializes concurrent retries after rereading under the claim lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-'));
  try {
    const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'race-test' });
    const id = await outbox.begin({ channelId, replyTo, content: 'final answer' });
    await outbox.update(id, { status: 'failed-before-start' });
    let calls = 0;
    let release;
    let resolveStarted;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const publisher = async () => {
      calls += 1;
      resolveStarted();
      await new Promise((resolve) => { release = resolve; });
      return { status: 'sent', eventId: 'e'.repeat(64) };
    };
    const first = outbox.retry(id, { owner: '1'.repeat(64), publish: publisher });
    await started;
    const second = outbox.retry(id, { owner: '1'.repeat(64), publish: publisher });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.ok(results.some((result) => result.status === 'sent'));
    assert.ok(results.some((result) => result.status === 'blocked'));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test('rejects traversal recovery ids before constructing a lock path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-'));
  try {
    const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64) });
    assert.deepEqual(await outbox.retry('../outside', { owner: '1'.repeat(64), publish: async () => ({ status: 'sent' }) }), { status: 'blocked', reason: 'invalid-id' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outbox is opt-in and stores no response when disabled', async () => {
  const outbox = new DeliveryOutbox();
  assert.equal(await outbox.begin({ channelId, replyTo, content: 'sensitive' }), null);
  assert.deepEqual(await outbox.update('missing', { status: 'uncertain' }), null);
  assert.deepEqual(await outbox.list(), []);
});

test('refuses publication when configured outbox durability fails', async () => {
  let publisherCalls = 0;
  let providerCalls = 0;
  const app = await memoryAcp({
    publisherFactory: () => ({ publish: async () => { publisherCalls += 1; return { status: 'sent', eventId: 'f'.repeat(64) }; } }),
    outboxFactory: () => ({ enabled: true, owner: '1'.repeat(64), begin: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, update: async () => {} }),
    sessionFactory: () => ({ prompt: async () => { providerCalls += 1; return 'completed response'; }, cancel: () => {} }),
    identityFactory: async () => '1'.repeat(64)
  });
  const prompt = [block('[Base]'), block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`)];
  await app.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: app.sessionId, prompt } });
  assert.equal(publisherCalls, 0);
  const response = app.messages.find((message) => message.id === 3);
  assert.equal(response.result.publication.status, 'failed-before-start');
  assert.match(response.result.publication.recoveryId, /^mem_/);
  const diagnostic = app.messages.find((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk' && message.params.update.content?.text?.startsWith('[Delivery status]'));
  assert.ok(diagnostic);
  assert.match(diagnostic.params.update.content.text, /failed-before-start/);
  const retried = await app.server.retryDelivery(response.result.publication.recoveryId, { identity: '1'.repeat(64) });
  assert.equal(retried.status, 'sent');
  assert.equal(providerCalls, 1);
  assert.equal(publisherCalls, 1);
});

test('rejects a partially configured outbox instead of silently dropping recovery', () => {
  const outbox = new DeliveryOutbox({ dir: 'C:/private/agy-outbox', owner: 'invalid-owner' });
  assert.match(outbox.configurationError, /AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER/);
  assert.equal(outbox.enabled, false);
});

test('recovery CLI verifies the current Buzz identity before retrying stored delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-cli-'));
  try {
    const owner = '1'.repeat(64);
    const outbox = new DeliveryOutbox({ dir, owner, idFn: () => 'cli-test' });
    await outbox.begin({ channelId, replyTo, content: 'operator response' });
    await outbox.update('cli-test', { status: 'failed-before-start' });
    const env = { ...process.env, AGY_OUTBOX_DIR: dir, AGY_OUTBOX_OWNER: owner,
      BUZZ_CLI_COMMAND: process.execPath, BUZZ_FAKE_SCRIPT: fakeBuzz, BUZZ_SELF_PUBKEY: owner,
      BUZZ_CALLS_FILE: join(dir, 'calls.txt') };
    const cli = join(root, 'bin', 'agy-buzz-recover.js');
    const listed = await execFileAsync(process.execPath, [cli, 'list'], { env });
    assert.match(listed.stdout, /cli-test/);
    const shown = await execFileAsync(process.execPath, [cli, 'show', 'cli-test'], { env });
    assert.match(shown.stdout, /operator response/);
    const retried = await execFileAsync(process.execPath, [cli, 'retry', 'cli-test'], { env });
    assert.match(retried.stdout, /"status":"sent"/);
    const calls = await readFile(join(dir, 'calls.txt'), 'utf8');
    assert.equal(calls.trim(), '1');
    await assert.rejects(execFileAsync(process.execPath, [cli, 'retry', 'cli-test'], { env: { ...env, BUZZ_SELF_PUBKEY: '2'.repeat(64) } }));
    assert.equal((await readFile(join(dir, 'calls.txt'), 'utf8')).trim(), '1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function memoryAcp({ publisherFactory, outboxFactory, sessionFactory, identityFactory }) {
  const output = new PassThrough();
  const messages = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) if (line.trim()) messages.push(JSON.parse(line));
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  const server = createAcpServer({ input: new PassThrough(), output, diagnostics: new PassThrough(),
    sessionFactory: sessionFactory ?? (() => ({ prompt: async () => 'completed response', cancel: () => {} })),
    publisherFactory, outboxFactory, identityFactory
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
  return { server, messages, sessionId: messages.find((message) => message.id === 2).result.sessionId };
}

test('returns completed response status and recovery id when publication fails before start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-acp-outbox-'));
  try {
    const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'server-failed' });
    const app = await memoryAcp({ publisherFactory: () => ({ publish: async () => ({ status: 'failed-before-start' }) }), outboxFactory: () => outbox });
    const prompt = [block('[Base]'), block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`)];
    await app.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: app.sessionId, prompt } });
    const response = app.messages.find((message) => message.id === 3);
    assert.equal(response.result.stopReason, 'end_turn');
    assert.equal(response.result.publication.status, 'failed-before-start');
    assert.equal(response.result.publication.recoveryId, 'server-failed');
    assert.equal((await outbox.get('server-failed')).status, 'failed-before-start');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('blocks volatile recovery when the current Buzz identity differs', async () => {
  let publisherCalls = 0;
  const outbox = { enabled: true, owner: '1'.repeat(64), begin: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const app = await memoryAcp({
    publisherFactory: () => ({ publish: async () => { publisherCalls += 1; return { status: 'sent', eventId: 'f'.repeat(64) }; } }),
    outboxFactory: () => outbox,
    identityFactory: async () => '2'.repeat(64)
  });
  const prompt = [block('[Base]'), block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`)];
  await app.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: app.sessionId, prompt } });
  const id = app.messages.find((message) => message.id === 3).result.publication.recoveryId;
  assert.deepEqual(await app.server.retryDelivery(id), { status: 'blocked', reason: 'owner-mismatch' });
  assert.equal(publisherCalls, 0);
});

test('serializes concurrent volatile recovery attempts', async () => {
  let publisherCalls = 0;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let release;
  const outbox = { enabled: true, owner: '1'.repeat(64), begin: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const app = await memoryAcp({
    publisherFactory: () => ({ publish: async () => {
      publisherCalls += 1;
      resolveStarted();
      await new Promise((resolve) => { release = resolve; });
      return { status: 'sent', eventId: 'f'.repeat(64) };
    } }),
    outboxFactory: () => outbox,
    identityFactory: async () => '1'.repeat(64)
  });
  const prompt = [block('[Base]'), block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`)];
  await app.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: app.sessionId, prompt } });
  const id = app.messages.find((message) => message.id === 3).result.publication.recoveryId;
  const first = app.server.retryDelivery(id);
  await started;
  const second = app.server.retryDelivery(id);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(publisherCalls, 1);
  assert.ok(results.some((result) => result.status === 'sent'));
  assert.ok(results.some((result) => result.status === 'blocked'));
});

test('marks a publication uncertain when cancellation interrupts the publisher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-acp-outbox-'));
  try {
    const outbox = new DeliveryOutbox({ dir, owner: '1'.repeat(64), idFn: () => 'server-cancel' });
    let resolvePublish;
    let resolveStarted;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const app = await memoryAcp({ publisherFactory: () => ({ publish: async (_request, signal) => new Promise((resolve) => {
      resolveStarted();
      resolvePublish = () => resolve({ status: 'uncertain', code: 'CANCELLED' });
      signal.addEventListener('abort', resolvePublish, { once: true });
    }) }), outboxFactory: () => outbox });
    const prompt = [block('[Base]'), block(`[Context]\nChannel: coordination (#${channelId})\nThread root: ${replyTo}`)];
    const pending = app.server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: app.sessionId, prompt } });
    await started;
    await app.server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: app.sessionId } });
    await pending;
    const response = app.messages.find((message) => message.id === 3);
    assert.equal(response.result.stopReason, 'cancelled');
    assert.equal(response.result.publication.status, 'uncertain');
    assert.equal((await outbox.get('server-cancel')).status, 'uncertain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
