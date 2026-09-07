import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { listModels, modelConfigOptions } from '../src/models.js';

function child() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stdout.setEncoding = () => {};
  process.killCalls = 0;
  process.kill = () => { process.killCalls += 1; };
  return process;
}

test('lists only valid tab-separated model rows and ignores the heading', async () => {
  const spawned = child();
  const pending = listModels({ command: 'agy', cwd: 'C:\\work', prefixArgs: ['fake.js'], spawnFn: (command, args, options) => {
    assert.equal(command, 'agy');
    assert.deepEqual(args, ['fake.js', 'models']);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, 'C:\\work');
    return spawned;
  } });
  spawned.stdout.emit('data', 'Fetching available models...\nnot a row\n');
  spawned.stdout.emit('data', 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-4\tClaude 4\n');
  spawned.stdout.emit('data', 'bad id!\tIgnored\n\tMissing id\n');
  spawned.emit('close', 0);
  assert.deepEqual(await pending, [
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'claude-4', name: 'Claude 4' }
  ]);
});

test('returns no catalog on timeout, spawn failure, or oversized output', async () => {
  const timed = child();
  const result = listModels({ timeoutMs: 10, spawnFn: () => timed });
  assert.deepEqual(await result, []);
  assert.equal(timed.killCalls, 1);
  assert.deepEqual(await listModels({ spawnFn: () => { throw new Error('no provider'); } }), []);
  const oversized = child();
  const bounded = listModels({ maxOutputBytes: 4, spawnFn: () => oversized });
  oversized.stdout.emit('data', '12345');
  assert.deepEqual(await bounded, []);
  assert.equal(oversized.killCalls, 1);
});

test('returns no catalog when stdout reports an error', async () => {
  const failing = child();
  const pending = listModels({ spawnFn: () => failing });
  failing.stdout.emit('error', new Error('provider stream unavailable'));
  assert.deepEqual(await pending, []);
  assert.equal(failing.killCalls, 1);
});

test('builds a stable model select with Buzz aliases', () => {
  assert.deepEqual(modelConfigOptions([
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'claude-4', name: 'Claude 4' }
  ], 'claude-4'), [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-4', configId: 'model', displayName: 'Model',
    options: [
      { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', displayName: 'Gemini 3.8 Flash (High)' },
      { value: 'claude-4', name: 'Claude 4', displayName: 'Claude 4' }
    ]
  }]);
  assert.deepEqual(modelConfigOptions([], 'configured-model'), []);
});
