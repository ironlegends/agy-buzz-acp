import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';

function app({ modelCatalogFactory, sessionFactory } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const messages = [];
  let buffer = '';
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
  const server = createAcpServer({ input, output, diagnostics, modelCatalogFactory, sessionFactory });
  return { server, messages };
}

test('session/new exposes the fetched catalog and config aliases', async () => {
  const seen = [];
  const { server, messages } = app({
    modelCatalogFactory: async (options) => {
      seen.push(options);
      return [{ modelId: 'claude-4', name: 'Claude 4' }, { modelId: 'gpt-5', name: 'GPT 5' }];
    },
    sessionFactory: (options) => ({
      options,
      setModelCatalog(catalog) { this.catalog = catalog; },
      setModel(model) { this.options.model = model; },
      prompt: async () => 'answer', close() {}
    })
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\work' } });
  const created = messages.find((message) => message.id === 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, 'C:\\work');
  assert.equal(created.result.configOptions[0].currentValue, 'gemini-3.8-flash-high');
  assert.equal(created.result.configOptions[0].category, 'model');
  assert.deepEqual(created.result.configOptions[0].options[1], {
    value: 'gpt-5', name: 'GPT 5', displayName: 'GPT 5'
  });
  await server.close();
});

test('set_config_option changes only a known prestart model', async () => {
  const sessionRecords = [];
  const { server, messages } = app({
    modelCatalogFactory: async () => [{ modelId: 'claude-4', name: 'Claude 4' }],
    sessionFactory: (options) => {
      const session = { options, setModelCatalog() {}, setModel(model) { this.options.model = model; }, close() {} };
      sessionRecords.push(session);
      return session;
    }
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\work' } });
  const sessionId = messages.find((message) => message.id === 2).result.sessionId;
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: 'claude-4' } });
  assert.equal(messages.find((message) => message.id === 3).result.configOptions[0].currentValue, 'claude-4');
  assert.equal(sessionRecords[0].options.model, 'claude-4');
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: 'gpt-5' } });
  assert.equal(messages.find((message) => message.id === 4).error.code, -32602);
  await server.close();
});

test('catalog failure leaves configured model usable without invented options', async () => {
  const { server, messages } = app({
    modelCatalogFactory: async () => { throw new Error('provider unavailable'); },
    sessionFactory: (options) => ({ options, setModelCatalog() {}, close() {} })
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\work' } });
  const created = messages.find((message) => message.id === 2);
  assert.equal(created.result.configOptions.length, 0);
  assert.equal(created.result.sessionId.startsWith('ses_'), true);
  await server.close();
});

test('session/new rejects a model override before provider discovery', async () => {
  let queried = false;
  const { server, messages } = app({
    modelCatalogFactory: async () => { queried = true; return []; },
    sessionFactory: () => ({ close() {} })
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\work', model: 'claude-4' } });
  assert.equal(messages.find((message) => message.id === 2).error.code, -32602);
  assert.equal(queried, false);
  await server.close();
});
