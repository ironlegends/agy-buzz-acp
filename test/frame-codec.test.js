import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineDecoder, createByteBudget, FRAME_TOO_LARGE, FRAME_TRUNCATED, FRAME_INVALID_UTF8, resolveFrameLimits } from '../src/frame-codec.js';

test('decodes lines split across chunks, including a multi-byte UTF-8 character split mid-sequence', () => {
  const text = 'hello éèê world';
  const bytes = Buffer.from(`${text}\n`, 'utf8');
  const results = [];
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const fresh = createLineDecoder({ maxLineBytes: 1024 });
    results.push(...fresh.push(bytes.subarray(0, cut)), ...fresh.push(bytes.subarray(cut)));
  }
  for (const result of results) {
    if (result.line !== undefined) assert.equal(result.line, text);
  }
});

test('allows empty lines without error', () => {
  const decoder = createLineDecoder({ maxLineBytes: 1024 });
  const results = decoder.push(Buffer.from('\n\nok\n\n', 'utf8'));
  assert.deepEqual(results.map((r) => r.line), ['', '', 'ok', '']);
});

test('reports a controlled error for a line exceeding the byte limit without retaining its bytes', () => {
  const decoder = createLineDecoder({ maxLineBytes: 8 });
  const results = decoder.push(Buffer.from('01234567890123456789\nok\n', 'utf8'));
  assert.equal(results.length, 2);
  assert.equal(results[0].error.code, FRAME_TOO_LARGE);
  assert.equal(results[1].line, 'ok');
});

test('reports one immediate overflow for a line spanning many chunks and keeps the decoder bounded', () => {
  const decoder = createLineDecoder({ maxLineBytes: 4 });
  let results = [];
  for (let i = 0; i < 50; i += 1) results = results.concat(decoder.push(Buffer.from('a'.repeat(1000), 'utf8')));
  assert.equal(results.length, 1);
  assert.equal(results[0].error.code, FRAME_TOO_LARGE);
  assert.deepEqual(decoder.push(Buffer.from('\n', 'utf8')), []);
  assert.deepEqual(decoder.push(Buffer.from('ok\n', 'utf8')), [{ line: 'ok' }]);
});

test('reports a controlled truncation when the stream ends mid-line', () => {
  const decoder = createLineDecoder({ maxLineBytes: 1024 });
  const results = decoder.push(Buffer.from('complete\npartial-no-newline', 'utf8'));
  assert.deepEqual(results.map((r) => r.line), ['complete']);
  const truncated = decoder.finish();
  assert.equal(truncated.error.code, FRAME_TRUNCATED);
});

test('finish() is a no-op when the stream ended cleanly on a newline', () => {
  const decoder = createLineDecoder({ maxLineBytes: 1024 });
  decoder.push(Buffer.from('complete\n', 'utf8'));
  assert.equal(decoder.finish(), null);
});

test('finish() reports invalid UTF-8 before classifying a partial frame as truncated', () => {
  const decoder = createLineDecoder({ maxLineBytes: 1024 });
  decoder.push(Buffer.from([0xff]));
  assert.equal(decoder.finish().error.code, FRAME_INVALID_UTF8);
});

test('rejects a non-positive maxLineBytes', () => {
  assert.throws(() => createLineDecoder({ maxLineBytes: 0 }), TypeError);
  assert.throws(() => createLineDecoder({ maxLineBytes: -1 }), TypeError);
});

test('createByteBudget tracks cumulative UTF-8 byte size and reports overflow', () => {
  const budget = createByteBudget(10);
  assert.equal(budget.add('12345'), true);
  assert.equal(budget.add('12345'), true);
  assert.equal(budget.bytes, 10);
  assert.equal(budget.add('x'), false);
});

test('configured protocol limits are capped at the shared safe defaults', () => {
  assert.deepEqual(resolveFrameLimits({
    maxFrameBytes: Number.MAX_SAFE_INTEGER,
    maxResponseBytes: Number.MAX_SAFE_INTEGER,
    maxDeferredBytes: Number.MAX_SAFE_INTEGER,
    maxDeferredEvents: Number.MAX_SAFE_INTEGER
  }), {
    maxFrameBytes: 8 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    maxDeferredBytes: 8 * 1024 * 1024,
    maxDeferredEvents: 1024
  });
});
