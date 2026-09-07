import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, runDoctorCli } from '../src/doctor.js';

async function executableFixture(testContext) {
  const root = await mkdtemp(join(tmpdir(), 'agy doctor path with spaces-'));
  const agy = join(root, 'bin', 'agy command');
  const buzz = join(root, 'tools', 'buzz command');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'tools'), { recursive: true });
  await writeFile(agy, 'placeholder', { mode: 0o700 });
  await writeFile(buzz, 'placeholder', { mode: 0o700 });
  testContext.after(() => rm(root, { recursive: true, force: true }));
  return { root, agy, buzz };
}

test('offline doctor is read-only, does not spawn commands, and omits secret values', async () => {
  let spawnCalls = 0;
  const report = await runDoctor({
    env: {
      AGY_COMMAND: 'agy',
      BUZZ_CLI_COMMAND: 'buzz',
      AGY_OUTBOX_OWNER: 'a'.repeat(64),
      AGY_TOKEN: 'token-secret-value'
    },
    spawnImpl: () => {
      spawnCalls += 1;
      throw new Error('offline mode must not spawn');
    },
    nodeVersion: '22.1.0',
    platform: 'linux'
  });

  assert.equal(report.mode, 'offline');
  assert.equal(spawnCalls, 0);
  assert.equal(report.node.supported, true);
  assert.equal(JSON.stringify(report).includes('owner-secret-value'), false);
  assert.equal(JSON.stringify(report).includes('token-secret-value'), false);
  assert.match(report.checks.map((check) => check.id).join(','), /agy-command/);
});

test('offline doctor resolves configured executable paths containing spaces', async (t) => {
  const fixture = await executableFixture(t);
  const report = await runDoctor({
    env: {
      AGY_COMMAND: fixture.agy,
      BUZZ_CLI_COMMAND: fixture.buzz,
      AGY_OUTBOX_DIR: join(fixture.root, 'state with spaces'),
      AGY_OUTBOX_OWNER: 'a'.repeat(64)
    },
    cwd: fixture.root,
    nodeVersion: '20.0.0',
    platform: 'linux'
  });

  assert.equal(report.commands.agy.status, 'pass');
  assert.equal(report.commands.buzz.status, 'pass');
  assert.equal(report.state.status, 'warn');
  assert.equal(report.state.configured, true);
  assert.equal(report.ok, true);
});

test('Windows state diagnostics warn that ACL privacy needs a separate check', async (t) => {
  const fixture = await executableFixture(t);
  const report = await runDoctor({
    env: {
      AGY_COMMAND: fixture.agy,
      BUZZ_CLI_COMMAND: fixture.buzz,
      AGY_OUTBOX_DIR: fixture.root,
      AGY_OUTBOX_OWNER: 'a'.repeat(64)
    },
    platform: 'win32',
    nodeVersion: '22.0.0'
  });

  assert.equal(report.state.status, 'warn');
  assert.match(report.state.message, /ACL/i);
  assert.equal(report.ok, true);
});

test('a relay URL alone leaves both persistence stores disabled', async () => {
  const report = await runDoctor({
    env: { BUZZ_RELAY_URL: 'https://relay.example.invalid' },
    nodeVersion: '22.0.0',
    platform: 'linux'
  });

  assert.equal(report.state.configured, false);
  assert.equal(report.state.status, 'pass');
  assert.equal(report.relay.configured, true);
  assert.match(report.relay.message, /does not enable persistence/i);
});

test('configured persistence owners must be 64 hexadecimal characters', async () => {
  const report = await runDoctor({
    env: {
      AGY_SESSION_DIR: 'C:\\state',
      AGY_SESSION_OWNER: 'short-owner'
    },
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.equal(report.state.stores.session.status, 'fail');
  assert.match(report.state.stores.session.message, /64 hexadecimal/i);
  assert.equal(JSON.stringify(report).includes('short-owner'), false);
});

test('configured missing dependencies are actionable failures', async () => {
  const report = await runDoctor({
    env: {
      AGY_COMMAND: 'C:\\missing path\\agy.exe',
      BUZZ_CLI_COMMAND: 'C:\\missing path\\buzz.exe'
    },
    nodeVersion: '24.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.equal(report.commands.agy.status, 'fail');
  assert.equal(report.commands.buzz.status, 'fail');
  assert.match(report.commands.agy.message, /not found/i);
  assert.match(report.commands.buzz.message, /not found/i);
});

test('Windows rejects directly configured batch shims', async () => {
  const fileFs = {
    stat: async () => ({ isFile: () => true, isDirectory: () => false, mode: 0o700 }),
    access: async () => {}
  };
  const report = await runDoctor({
    env: { AGY_COMMAND: 'C:\\tools\\agy.cmd', BUZZ_CLI_COMMAND: 'C:\\tools\\buzz.bat' },
    fsImpl: fileFs,
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.equal(report.commands.agy.status, 'fail');
  assert.equal(report.commands.buzz.status, 'fail');
  assert.match(report.commands.agy.message, /batch shim/i);
  assert.match(report.commands.buzz.message, /batch shim/i);
});

test('Windows skips batch PATHEXT candidates and selects a later executable', async () => {
  const toolPath = join(tmpdir(), 'agy doctor windows tools');
  const fileFs = {
    stat: async (candidate) => ({
      isFile: () => candidate.endsWith('.cmd') || candidate.endsWith('.exe'),
      isDirectory: () => false,
      mode: 0o700
    }),
    access: async () => {}
  };
  const report = await runDoctor({
    env: {
      PATH: toolPath,
      PATHEXT: '.CMD;.EXE',
      AGY_COMMAND: 'agy'
    },
    fsImpl: fileFs,
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.commands.agy.status, 'pass');
  assert.match(report.commands.agy.path, /agy\.exe$/i);
});

test('offline doctor uses shared standard executable discovery', async () => {
  const standard = 'C:\\Users\\tester\\AppData\\Local\\Buzz\\buzz.exe';
  const report = await runDoctor({
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    platform: 'win32',
    nodeVersion: '22.0.0',
    fsImpl: {
      stat: async (candidate) => {
        if (candidate !== standard) throw new Error('missing');
        return { isFile: () => true };
      },
      access: async () => {}
    }
  });

  assert.equal(report.commands.buzz.status, 'pass');
  assert.equal(report.commands.buzz.source, 'standard');
  assert.equal(report.commands.buzz.path, standard);
});

test('durable session state requires a valid Buzz relay URL', async () => {
  const report = await runDoctor({
    env: {
      AGY_SESSION_DIR: 'C:\\session-state',
      AGY_SESSION_OWNER: 'a'.repeat(64)
    },
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.equal(report.state.stores.session.status, 'fail');
  assert.match(report.state.stores.session.message, /BUZZ_RELAY_URL/i);
});

test('durable session state rejects a malformed Buzz relay without echoing it', async () => {
  const relay = 'not a relay credential=secret';
  const report = await runDoctor({
    env: {
      AGY_SESSION_DIR: 'C:\\session-state',
      AGY_SESSION_OWNER: 'a'.repeat(64),
      BUZZ_RELAY_URL: relay
    },
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.match(report.state.stores.session.message, /malformed/i);
  assert.equal(JSON.stringify(report).includes(relay), false);
});

test('session relay aliases must match including query strings without exposing URLs', async () => {
  const relay = 'https://relay.example.invalid/acp?credential=one';
  const otherRelay = 'https://relay.example.invalid/acp?credential=two';
  const report = await runDoctor({
    env: {
      AGY_SESSION_DIR: 'C:\\session-state',
      AGY_SESSION_OWNER: 'b'.repeat(64),
      BUZZ_RELAY_URL: relay,
      AGY_RELAY_URL: otherRelay
    },
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.ok, false);
  assert.equal(report.state.stores.session.status, 'fail');
  assert.match(report.state.stores.session.message, /match/i);
  assert.equal(JSON.stringify(report).includes(relay), false);
  assert.equal(JSON.stringify(report).includes(otherRelay), false);
});

test('matching canonical session relay URLs retain their query in the comparison', async () => {
  const relay = 'https://RELAY.example.invalid/acp/?mode=portable';
  const report = await runDoctor({
    env: {
      AGY_SESSION_DIR: 'C:\\session-state',
      AGY_SESSION_OWNER: 'c'.repeat(64),
      BUZZ_RELAY_URL: relay,
      AGY_RELAY_URL: 'https://relay.example.invalid/acp?mode=portable'
    },
    nodeVersion: '22.0.0',
    platform: 'win32'
  });

  assert.equal(report.state.stores.session.status, 'warn');
  assert.equal(report.ok, true);
});

test('unsupported Node versions fail before capability checks', async () => {
  let spawnCalls = 0;
  const report = await runDoctor({
    checkCapabilities: true,
    env: {},
    nodeVersion: '19.9.0',
    platform: 'darwin',
    spawnImpl: () => {
      spawnCalls += 1;
      throw new Error('capability checks should not run with an unsupported Node');
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.node.supported, false);
  assert.equal(spawnCalls, 0);
});

test('capability checks launch standard-location executables without PATH', async () => {
  const agyPath = 'C:\\Users\\Example\\AppData\\Local\\agy\\bin\\agy.exe';
  const buzzPath = 'C:\\Users\\Example\\AppData\\Local\\Buzz\\buzz.exe';
  const available = new Set([agyPath, buzzPath]);
  const commands = [];
  const report = await runDoctor({
    env: { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local', PATH: '' },
    platform: 'win32', nodeVersion: '22.0.0', checkCapabilities: true,
    fsImpl: { stat: async candidate => ({ isFile: () => available.has(candidate) }), access: async () => {} },
    spawnImpl: command => {
      commands.push(command);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', available.has(command) ? 0 : 1));
      return child;
    }
  });
  assert.equal(report.ok, true);
  assert.deepEqual(commands, [agyPath, agyPath, buzzPath]);
});

test('capability checks are explicit, bounded, shell-free, and discard command output', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', 'secret command output');
      child.stderr.emit('data', 'secret error output');
      child.emit('close', 0);
    });
    child.kill = () => {};
    return child;
  };
  const report = await runDoctor({
    checkCapabilities: true,
    env: { AGY_COMMAND: 'agy', BUZZ_CLI_COMMAND: 'buzz' },
    nodeVersion: '22.0.0',
    platform: 'linux',
    spawnImpl,
    timeoutMs: 50
  });

  assert.equal(report.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ args }) => args), [['--version'], ['--help'], ['--help']]);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
  assert.equal(calls.every(({ options }) => options.timeout === 50), true);
  assert.equal(JSON.stringify(report).includes('secret command output'), false);
  assert.equal(JSON.stringify(report).includes('secret error output'), false);
});

test('CLI wrapper exposes help without loading or invoking the adapter runtime', async () => {
  let output = '';
  let errors = '';
  const exitCode = await runDoctorCli(['--help'], {
    env: { AGY_COMMAND: 'should-not-be-read' },
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { errors += value; } }
  });

  assert.equal(exitCode, 0);
  assert.match(output, /Usage: agy-buzz-doctor/);
  assert.equal(errors, '');
});
