import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

async function app(waitForClose) {
  let releases = 0;
  const server = createAcpServer({
    input: new PassThrough(), output: new PassThrough(), diagnostics: new PassThrough(), shutdownTimeoutMs: 20,
    ...isolatedServerOptions({
      sessionFactory: () => ({ close() {}, waitForClose }),
      sessionStateFactory: () => ({ enabled: false, async release() { releases++; } })
    })
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
  assert.equal(server.sessions.size, 1);
  return { server, releases: () => releases };
}

test('shutdown has an overall bound and retains ownership without confirmed close', async () => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const { server, releases } = await app(() => pending);
  const deadline = new Promise(resolve => setTimeout(() => resolve('unbounded'), 150));
  try {
    const outcome = await Promise.race([server.close().then(() => 'released', error => error.code), deadline]);
    assert.equal(outcome, 'AGY_SHUTDOWN_UNCONFIRMED');
    assert.equal(releases(), 0);
  } finally { settle(); }
});

test('rejected provider close retains ownership instead of accepting allSettled', async () => {
  const { server, releases } = await app(async () => { throw new Error('private provider details'); });
  await assert.rejects(server.close(), error => error.code === 'AGY_SHUTDOWN_UNCONFIRMED' &&
    !error.message.includes('private'));
  assert.equal(releases(), 0);
});

test('confirmed shutdown releases ownership once and shares completion', async () => {
  const { server, releases } = await app(async () => {});
  await Promise.all([server.close(), server.close()]);
  assert.equal(releases(), 1);
});
