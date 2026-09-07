import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'bin', 'agy-buzz-acp.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
function run(args, input = '') {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root, input, encoding: 'utf8', timeout: 15000, shell: false,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      AGY_COMMAND: process.execPath, BUZZ_CLI_COMMAND: process.execPath,
      AGY_FAKE_SCRIPT: join(root, 'fixtures', 'fake-models.js'),
      AGY_MODEL: 'gemini-test-high', BUZZ_PRIVATE_KEY: 'synthetic-never-print' }
  });
}

test('CLI help and version exit without entering the ACP stream', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /models/);
  assert.match(help.stdout, /setup/);
  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), pkg.version);
});

test('CLI setup prints a directly launchable harness without credentials', () => {
  const setup = run(['setup']);
  assert.equal(setup.status, 0, setup.stderr);
  const config = JSON.parse(setup.stdout);
  assert.equal(config.command, process.execPath);
  assert.deepEqual(config.args, [entry]);
  assert.equal(config.env.AGY_COMMAND, process.execPath);
  assert.equal(config.env.BUZZ_CLI_COMMAND, process.execPath);
  assert.equal(config.env.AGY_MODEL, 'gemini-test-high');
  assert.equal(setup.stdout.includes('synthetic-never-print'), false);
});

test('CLI models exposes the provider catalog in the Buzz probe shape', () => {
  const result = run(['models']);
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.agent.version, pkg.version);
  assert.equal(catalog.unstable.currentModelId, 'gemini-test-high');
  assert.deepEqual(catalog.unstable.availableModels.map(model => model.modelId), ['gemini-test-high', 'claude-test']);
  assert.equal(catalog.stable.configOptions[0].category, 'model');
  assert.equal(result.stdout.includes('synthetic-never-print'), false);
});

test('CLI rejects unsupported commands without starting an ACP session', () => {
  assert.equal(run(['unknown-command']).status, 2);
});

test('default CLI remains a JSON-only ACP stream without model discovery', () => {
  const result = run([], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } }) + '\n');
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentInfo.version, pkg.version);
});
