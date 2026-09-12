import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

function startMemoryServer(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const messages = [];
  const diagnosticLines = [];
  let buffer = '';
  let diagBuffer = '';
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
  diagnostics.setEncoding('utf8');
  diagnostics.on('data', (chunk) => {
    diagBuffer += chunk;
    let index;
    while ((index = diagBuffer.indexOf('\n')) >= 0) {
      diagnosticLines.push(diagBuffer.slice(0, index));
      diagBuffer = diagBuffer.slice(index + 1);
    }
  });
  const server = createAcpServer({ input, output, diagnostics, ...isolatedServerOptions(options) });
  const sendRaw = (text) => input.write(text);
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate, timeoutMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`timed out; seen=${JSON.stringify(messages)}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { input, output, messages, diagnosticLines, send, sendRaw, waitFor, settle, server };
}

async function initialize(server, id = 1) {
  server.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1 } });
  await server.waitFor((m) => m.id === id);
}

test('a top-level null message gets a controlled invalid-request error, not a crash', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.sendRaw('null\n');
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32600);
  assert.equal(error.id, null);
});

test('a top-level array message gets a controlled invalid-request error', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.sendRaw('[1,2,3]\n');
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32600);
});

test('a top-level scalar message gets a controlled invalid-request error', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.sendRaw('"just a string"\n');
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32600);
});

test('a non-primitive request id is rejected with a null id in the error, never echoed back', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: { nested: true }, method: 'initialize', params: { protocolVersion: 1 } })}\n`);
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32600);
  assert.equal(error.id, null);
});

test('an array id is rejected without dereferencing it as a request id', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: [1], method: 'initialize', params: { protocolVersion: 1 } })}\n`);
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32600);
});

test('array params are treated as absent rather than dereferenced positionally', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  await initialize(server);
  server.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: ['not', 'an', 'object'] });
  const error = await server.waitFor((m) => m.id === 2);
  assert.equal(error.error.code, -32602);
});

test('null params are treated as absent', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  await initialize(server);
  server.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: null });
  const error = await server.waitFor((m) => m.id === 2);
  assert.equal(error.error.code, -32602);
});

test('a scalar params value is treated as absent', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  await initialize(server);
  server.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: 'not-an-object' });
  const error = await server.waitFor((m) => m.id === 2);
  assert.equal(error.error.code, -32602);
});

test('a valid notification (no id) produces no reply even when it fails', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.send({ jsonrpc: '2.0', method: 'session/new', params: { cwd: 'not-absolute' } });
  await server.settle(); await server.settle();
  assert.equal(server.messages.length, 0);
});

test('a valid notification that succeeds is still processed with no reply', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.send({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: 1 } });
  await server.settle(); await server.settle();
  assert.equal(server.messages.length, 0);
  server.send({ jsonrpc: '2.0', id: 9, method: 'session/new', params: { cwd: process.cwd() } });
  const result = await server.waitFor((m) => m.id === 9);
  assert.ok(result.result?.sessionId);
});

test('an oversized single line is rejected with a controlled parse error, not an unbounded buffer', async (t) => {
  const server = startMemoryServer({ frameLimits: { maxFrameBytes: 64 } }); t.after(() => server.server.close());
  server.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, padding: 'x'.repeat(1000) } })}\n`);
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32700);
  assert.match(error.error.message, /too large/);
});

test('a stream that ends mid-line does not crash and is reported as a controlled diagnostic', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  server.input.write('{"jsonrpc":"2.0","id":1,"method":"initializ');
  server.input.end();
  await server.settle(); await server.settle(); await server.settle();
  assert.ok(server.diagnosticLines.some((line) => /incomplete request/.test(line)));
});

test('fragmented multi-byte UTF-8 content across chunk boundaries decodes correctly', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, note: 'héllo wörld ☕' } });
  const bytes = Buffer.from(`${message}\n`, 'utf8');
  const cut = bytes.findIndex((byte, index) => index > 0 && (byte & 0xc0) === 0x80);
  server.input.write(bytes.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 5));
  server.input.write(bytes.subarray(cut));
  const result = await server.waitFor((m) => m.id === 1);
  assert.equal(result.result.protocolVersion, 1);
});

test('invalid UTF-8 in a request frame is rejected with a controlled parse error', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  const prefix = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"note":"', 'utf8');
  const suffix = Buffer.from('"}}\n', 'utf8');
  server.input.write(Buffer.concat([prefix, Buffer.from([0xff]), suffix]));
  const error = await server.waitFor((m) => m.error);
  assert.equal(error.error.code, -32700);
  assert.match(error.error.message, /invalid UTF-8/i);
});

test('malformed request method without id is an invalid request, not a notification', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  await server.server.handle({ jsonrpc: '2.0', method: 123 });
  assert.equal(server.messages.at(-1)?.error?.code, -32600);
});

test('non-finite request ids are never echoed as successful requests', async (t) => {
  const server = startMemoryServer(); t.after(() => server.server.close());
  await server.server.handle({ jsonrpc: '2.0', id: Infinity, method: 'initialize', params: { protocolVersion: 1 } });
  assert.equal(server.messages.at(-1)?.error?.code, -32600);
});
