import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgySession } from '../src/agy-session.js';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

function hungChild() {
  const c = new EventEmitter(); c.stdout = new PassThrough(); c.stdin = new EventEmitter();
  c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => true;
  return c;
}
test('retirement requires close even after error has cleared the child reference', async () => {
  const c = hungChild(); const s = new AgySession({ spawnFn: () => c, retireTimeoutMs: 20 });
  const turn = s.prompt('synthetic').catch((e) => e);
  c.emit('error', new Error('synthetic error without close'));
  await turn; assert.equal(s.child, null);
  await assert.rejects(s.retireForRecovery(), /close.*timed out/);
  assert.equal(s.closed, false); assert.equal(s.contextLost, true);
  c.emit('close', 1);
  assert.equal(await s.retireForRecovery(), true);
  assert.equal(s.closed, true); assert.equal(s.contextLost, true, 'failed object is never reset');
});
test('recovery refuses while a provider turn is active', async () => {
  const c = hungChild(); const s = new AgySession({ spawnFn: () => c, retireTimeoutMs: 20 });
  const turn = s.prompt('synthetic').catch(() => null);
  await assert.rejects(s.retireForRecovery(), /previous operations/);
  s.close(); c.emit('close', 0); await turn;
});
test('unconfirmed retirement prevents disk reconciliation and concurrent recovery', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-unclosed-'));
  const owner = 'ab'.repeat(32), channelId = '123e4567-e89b-42d3-a456-426614174000';
  const state = new SessionState({ dir: join(dir, 'sessions'), owner, relay: 'wss://probe.invalid' });
  const outbox = new DeliveryOutbox({ dir: join(dir, 'outbox'), owner });
  const c = hungChild(); let spawned = false;
  const s = new AgySession({ spawnFn: () => { spawned = true; return c; }, retireTimeoutMs: 150 });
  const output = new PassThrough(); let wire = ''; output.on('data', (v) => { wire += v; });
  const server = createAcpServer({ input: new PassThrough(), output, diagnostics: new PassThrough(),
    ...isolatedServerOptions({ sessionFactory: () => s, sessionStateFactory: () => state,
      outboxFactory: () => outbox, identityFactory: async () => owner }),
    steeringSupported: true, steeringConfig: { rootDir: join(dir,'steering'), ownerId: owner, hookConfigured: true, injectorExclusive: true } });
  const rpc = (id, method, params) => server.handle({ jsonrpc:'2.0', id, method, params });
  const response = (id) => wire.trim().split('\n').map(JSON.parse).find((m) => m.id === id);
  try {
    await rpc(1,'initialize',{ protocolVersion:1 }); await rpc(2,'session/new',{ cwd:dir });
    const sessionId = [...server.sessions.keys()][0];
    const params = { sessionId, prompt:[{ type:'text', text:`<context>\nChannel: test (#${channelId})\nThread root: ${'f'.repeat(64)}\n</context>` },{ type:'text',text:'synthetic' }] };
    const first = rpc(3,'session/prompt',params);
    const limit = Date.now()+8000;
    while (!spawned && Date.now()<limit) await new Promise((r) => setTimeout(r,10));
    assert.equal(spawned,true);
    c.emit('error',new Error('synthetic provider failure')); await first;
    assert.ok(response(3).error);
    const before = await readFile(state.path(channelId),'utf8');
    const recovery = rpc(4,'session/prompt',params);
    await rpc(5,'session/prompt',params);
    assert.equal(response(5).error.code, -32002);
    await recovery; assert.match(response(4).error.message,/close.*timed out/);
    assert.equal(await readFile(state.path(channelId),'utf8'),before);
    assert.equal((await readdir(join(dir,'steering'))).some((v) => v.includes('-archived-')), false);
  } finally { c.emit('close',1); await server.close(); await state.release(); await rm(dir,{ recursive:true,force:true }); }
});
