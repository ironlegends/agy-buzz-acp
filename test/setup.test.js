import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessConfig } from '../src/setup.js';

test('buildHarnessConfig emits absolute paths and only a safe model value', async () => {
  const calls = [];
  const config = await buildHarnessConfig({
    env: {
      AGY_MODEL: 'gemini-3.1-pro-high',
      AGY_TOKEN: 'token-secret-value',
      BUZZ_RELAY_URL: 'wss://relay.example.invalid/private?token=secret',
      AGY_OUTBOX_DIR: 'C:\\private outbox'
    },
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    adapterPath: 'C:\\tools with spaces\\agy-buzz-acp.js',
    resolveFn: async ({ name }) => {
      calls.push(name);
      return { path: name === 'agy' ? 'C:\\agy\\agy.exe' : 'C:\\Buzz\\buzz.exe', source: 'standard' };
    }
  });

  assert.deepEqual(calls, ['agy', 'buzz']);
  assert.deepEqual(config, {
    id: 'agy-buzz-acp',
    label: 'Antigravity (agy-buzz-acp)',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\tools with spaces\\agy-buzz-acp.js'],
    env: {
      AGY_COMMAND: 'C:\\agy\\agy.exe',
      BUZZ_CLI_COMMAND: 'C:\\Buzz\\buzz.exe',
      AGY_MODEL: 'gemini-3.1-pro-high'
    }
  });
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes('token-secret-value'), false);
  assert.equal(serialized.includes('relay.example.invalid'), false);
  assert.equal(serialized.includes('private outbox'), false);
});

test('buildHarnessConfig refuses unresolved providers without writing files or invoking providers', async () => {
  let resolveCalls = 0;
  await assert.rejects(() => buildHarnessConfig({
    env: {},
    platform: 'linux',
    nodePath: '/usr/bin/node',
    adapterPath: '/opt/agy-buzz-acp.js',
    resolveFn: async () => {
      resolveCalls += 1;
      return null;
    }
  }), /agy executable could not be resolved/i);

  assert.equal(resolveCalls, 2);
});

test('buildHarnessConfig rejects an unsafe explicit model value', async () => {
  await assert.rejects(() => buildHarnessConfig({
    env: { AGY_MODEL: 'unsafe model' },
    platform: 'linux',
    nodePath: '/usr/bin/node',
    adapterPath: '/opt/agy-buzz-acp.js',
    resolveFn: async ({ name }) => ({ path: `/usr/bin/${name}`, source: 'path' })
  }), /AGY_MODEL/i);
});
