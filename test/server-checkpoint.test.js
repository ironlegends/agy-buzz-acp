import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';

for (const retirementFails of [false, true]) {
  test(`durable checkpoint requires retired provider (${retirementFails ? 'failure' : 'success'})`, async () => {
    let record = null;
    let retired = false;
    let delivered = false;
    let providerCalls = 0;
    let retirementCalls = 0;
    const state = { enabled: true, verifyIdentity: async () => {}, scope: async () => ({}),
      load: async () => null, invalidate: async () => { record = 'blocked'; },
      save: async () => { assert.equal(retired, true, 'ready cannot precede provider exit'); record = 'ready'; },
      release: async () => {} };
    const server = createAcpServer({ input: new PassThrough(), output: new PassThrough(), diagnostics: new PassThrough(),
      sessionStateFactory: () => state, outboxFactory: () => null,
      sessionFactory: () => ({ prompt: async () => { providerCalls++; return 'answer'; },
        getConversationId: () => 'confirmed', hasConfirmedConversation: () => true,
        retireForCheckpoint: async () => {
          retirementCalls++;
          assert.equal(delivered, true);
          assert.equal(record, 'blocked');
          if (retirementFails) throw new Error('provider still alive');
          retired = true;
          return 'confirmed';
        }, close() {} }),
      publisherFactory: () => ({ publish: async () => { delivered = true; return { status: 'sent' }; } }) });
    const call = (id, method, params) => server.handle({ jsonrpc: '2.0', id, method, params });
    try {
      await call(1, 'initialize', { protocolVersion: 1 });
      await call(2, 'session/new', { cwd: process.cwd() });
      const params = { sessionId: [...server.sessions.keys()][0], prompt: [
        { type: 'text', text: '<context>\nChannel: test (#11111111-1111-4111-8111-111111111111)\nThread root: ' + 'a'.repeat(64) + '\n</context>' },
        { type: 'text', text: 'Synthetic test' }] };
      await call(3, 'session/prompt', params);
      assert.equal(retirementCalls, 1);
      assert.equal(record, retirementFails ? 'blocked' : 'ready');
      if (retirementFails) {
        await call(4, 'session/prompt', params);
        assert.equal(providerCalls, 1, 'failed retirement must block the next turn');
      }
    } finally { await server.close(); }
  });
}
