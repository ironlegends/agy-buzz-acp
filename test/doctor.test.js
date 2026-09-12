import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { link, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDoctorArgs, runDoctor, runDoctorCli } from '../src/doctor.js';
import { inspectStateDirectory, stateSummaryStatus } from '../src/status.js';

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
    env: { AGY_COMMAND: '/fixture/bin/agy', BUZZ_CLI_COMMAND: '/fixture/bin/buzz' },
    fsImpl: { stat: async () => ({ isFile: () => true }), access: async () => {} },
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

test('doctor reports a harness package version and keeps running version unknown', async (t) => {
  const harnessRoot = await mkdtemp(join(tmpdir(), 'agy-doctor-harness-'));
  t.after(() => rm(harnessRoot, { recursive: true, force: true }));
  const adapterPath = join(process.cwd(), 'bin', 'agy-buzz-acp.js');
  const harnessPath = join(harnessRoot, 'harness.json');
  await writeFile(harnessPath, JSON.stringify({
    id: 'agy-buzz-acp', command: process.execPath,
    args: [adapterPath],
    env: { AGY_COMMAND: process.execPath, BUZZ_CLI_COMMAND: process.execPath, AGY_TOKEN: 'secret' }
  }));
  const report = await runDoctor({
    harness: harnessPath, env: {}, platform: process.platform, nodeVersion: '22.0.0'
  });

  assert.equal(report.harness.status, 'pass');
  assert.match(report.harness.adapter.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(report.harness.adapter.runningVersion, null);
  assert.equal(report.harness.paths.adapterPath, adapterPath);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('harness diagnostics read the target package metadata instead of the doctor package', async (t) => {
  const harnessRoot = await mkdtemp(join(tmpdir(), 'agy-doctor-old-harness-'));
  t.after(() => rm(harnessRoot, { recursive: true, force: true }));
  await mkdir(join(harnessRoot, 'bin'));
  const adapterPath = join(harnessRoot, 'bin', 'agy-buzz-acp.js');
  await writeFile(adapterPath, '#!/usr/bin/env node');
  await writeFile(join(harnessRoot, 'package.json'), JSON.stringify({ name: 'agy-buzz-acp', version: '0.1.2' }));
  const harnessPath = join(harnessRoot, 'harness.json');
  await writeFile(harnessPath, JSON.stringify({ id: 'agy-legacy-custom', command: process.execPath.replaceAll('\\', '/'),
    args: [adapterPath], env: { AGY_COMMAND: process.execPath, BUZZ_CLI_COMMAND: process.execPath } }));

  const report = await runDoctor({ harness: harnessPath, env: {}, platform: process.platform, nodeVersion: '22.0.0' });

  assert.equal(report.harness.adapter.configuredVersion, '0.1.2');
  assert.equal(report.adapter.configuredVersion, '0.1.2');
  assert.equal(report.harness.adapter.runningVersion, null);
  assert.notEqual(report.doctorVersion, report.harness.adapter.configuredVersion);
});

test('latest release lookup is opt-in, bounded, and sends no auth headers', async () => {
  let calls = 0;
  let request;
  const report = await runDoctor({
    latest: true, env: {}, platform: 'linux', nodeVersion: '22.0.0',
    fetchImpl: async (url, options) => {
      calls += 1; request = { url, options };
      return { ok: true, json: async () => ({ tag_name: 'v0.4.0' }) };
    }
  });

  assert.equal(calls, 1);
  assert.match(request.url, /api\.github\.com\/repos\/ironlegends\/agy-buzz-acp\/releases\/latest$/);
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(report.latest.status, 'pass');
  assert.equal(report.latest.version, '0.4.0');
});

test('latest release body is bounded and timeout covers response parsing', async () => {
  const oversized = await runDoctor({ latest: true, timeoutMs: 10, env: {}, nodeVersion: '22.0.0',
    fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(64 * 1024 + 1) }) });
  assert.equal(oversized.latest.status, 'warn');
  const started = Date.now();
  const hanging = await runDoctor({ latest: true, timeoutMs: 10, env: {}, nodeVersion: '22.0.0',
    fetchImpl: async () => ({ ok: true, text: async () => new Promise(() => {}) }) });
  assert.equal(hanging.latest.status, 'warn');
  assert.ok(Date.now() - started < 1000);
});

test('models lookup is opt-in and launches the configured agy without a shell', async () => {
  const agy = 'C:\\tools\\agy.exe';
  const calls = [];
  const report = await runDoctor({
    models: true,
    env: { AGY_COMMAND: agy }, platform: 'win32', nodeVersion: '22.0.0',
    fsImpl: { stat: async () => ({ isFile: () => true }), access: async () => {} },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit('data', 'gemini-test-high\tGemini Test\n'); child.emit('close', 0); });
      return child;
    }
  });

  assert.equal(report.models.status, 'pass');
  assert.deepEqual(report.models.models, [{ modelId: 'gemini-test-high', name: 'Gemini Test' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].options.shell, false);
});

test('state diagnostics summarize records and stale locks without mutating files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-doctor-state-'));
  const outbox = join(root, 'outbox');
  const session = join(root, 'session');
  await mkdir(outbox); await mkdir(session);
  const outboxBase = { recoveryId: 'sent', owner: 'a'.repeat(64), channelId: '11111111-1111-4111-8111-111111111111', replyTo: 'd'.repeat(64), content: 'private answer', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(join(outbox, 'sent.json'), JSON.stringify({ ...outboxBase, status: 'sent', eventId: 'e'.repeat(64) }));
  await writeFile(join(outbox, 'uncertain.json'), JSON.stringify({ ...outboxBase, recoveryId: 'uncertain', status: 'uncertain' }));
  const scope = { owner: 'b'.repeat(64), relay: 'c'.repeat(64), cwd: root, model: 'gemini-test-high', channelId: '11111111-1111-4111-8111-111111111111' };
  await writeFile(join(session, 'ready.json'), JSON.stringify({ schemaVersion: 1, sessionScope: 'channel', status: 'ready', scope, conversationId: 'private-conversation', updatedAt: new Date().toISOString() }));
  await writeFile(join(session, 'blocked.json'), JSON.stringify({ schemaVersion: 1, sessionScope: 'channel', status: 'blocked', scope, conversationId: null, updatedAt: new Date().toISOString() }));
  const lock = join(session, '.deadbeef.lock');
  await mkdir(lock); await writeFile(join(lock, 'owner'), '999999\n');
  await utimes(lock, new Date(0), new Date(0));
  t.after(() => rm(root, { recursive: true, force: true }));

  const report = await runDoctor({
    env: { AGY_OUTBOX_DIR: outbox, AGY_OUTBOX_OWNER: 'a'.repeat(64), AGY_SESSION_DIR: session, AGY_SESSION_OWNER: 'b'.repeat(64), BUZZ_RELAY_URL: 'https://relay.example.invalid' },
    platform: 'linux', nodeVersion: '22.0.0',
    processAliveImpl: () => false
  });

  assert.equal(report.state.stores.outbox.records.ready, 1);
  assert.equal(report.state.stores.outbox.records.uncertain, 1);
  assert.equal(report.state.stores.outbox.records.uncertain, 1);
  assert.equal(report.state.stores.session.records.ready, 1);
  assert.equal(report.state.stores.session.records.blocked, 1);
  assert.equal(report.state.stores.session.locks.stale, 1);
  assert.equal(report.state.status, 'warn');
  assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(outbox, 'uncertain.json'), 'utf8')).then((value) => value.includes('uncertain')), true);
  assert.equal(JSON.stringify(report).includes('private-conversation'), false);
});

test('state scanner strictly validates records and bounds entries without following symlinks', async () => {
  let reads = 0;
  const fsImpl = {
    lstat: async (path) => {
      if (path === 'root') return { isDirectory: () => true, isSymbolicLink: () => false };
      if (path.endsWith('link.json')) return { isFile: () => true, isSymbolicLink: () => true };
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 20 };
    },
    readdir: async () => ['root/link.json', ...Array.from({ length: 1001 }, (_, index) => `record-${index}.json`)],
    readFile: async (path) => { reads += 1; return JSON.stringify({ status: 'ready' }); }
  };
  const summary = await inspectStateDirectory('root', { kind: 'session', fsImpl });

  assert.equal(summary.entries.truncated, true);
  assert.equal(summary.records.invalid, 1000);
  assert.equal(reads, 999);
  assert.equal(summary.scan.status, 'warn');
});

test('outbox diagnostics bind each record to its filename and configured owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-doctor-outbox-binding-'));
  const timestamp = new Date().toISOString();
  const base = { owner: 'a'.repeat(64), channelId: '11111111-1111-4111-8111-111111111111', replyTo: 'd'.repeat(64), content: 'private answer', status: 'uncertain', createdAt: timestamp, updatedAt: timestamp };
  await writeFile(join(root, 'named.json'), JSON.stringify({ ...base, recoveryId: 'different' }));
  await writeFile(join(root, 'owner.json'), JSON.stringify({ ...base, recoveryId: 'owner', owner: 'b'.repeat(64) }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await inspectStateDirectory(root, { kind: 'outbox', expectedOwner: 'a'.repeat(64) });

  assert.equal(summary.records.invalid, 2);
  assert.equal(summary.statuses.invalid, 2);
  assert.equal(summary.records.uncertain, 0);
});

test('outbox diagnostics reject invalid UTF-8 through the bounded reader', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-doctor-outbox-utf8-'));
  const timestamp = '2026-09-11T00:00:00.000Z';
  const record = { recoveryId: 'sample', owner: 'a'.repeat(64), channelId: '11111111-1111-4111-8111-111111111111',
    replyTo: 'd'.repeat(64), content: 'invalid-utf8-marker', status: 'failed-before-start',
    createdAt: timestamp, updatedAt: timestamp };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const marker = Buffer.from('invalid-utf8-marker', 'utf8');
  const offset = bytes.indexOf(marker);
  assert.notEqual(offset, -1);
  bytes[offset] = 0xff;
  await writeFile(join(root, 'sample.json'), bytes);
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await inspectStateDirectory(root, { kind: 'outbox', expectedOwner: record.owner });

  assert.equal(summary.scan.status, 'warn');
  assert.equal(summary.records.ready, 0);
  assert.equal(summary.records.invalid, 1);
  assert.equal(summary.statuses.invalid, 1);
  assert.equal(summary.statuses['failed-before-start'], 0);
});

test('outbox diagnostics reject records with more than one hardlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-doctor-outbox-link-'));
  const timestamp = '2026-09-11T00:00:00.000Z';
  const record = { recoveryId: 'sample', owner: 'a'.repeat(64), channelId: '11111111-1111-4111-8111-111111111111',
    replyTo: 'd'.repeat(64), content: 'private answer', status: 'failed-before-start',
    createdAt: timestamp, updatedAt: timestamp };
  const target = join(root, 'record-target.bin');
  const recordPath = join(root, 'sample.json');
  await writeFile(target, `${JSON.stringify(record)}\n`);
  await link(target, recordPath);
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await inspectStateDirectory(root, { kind: 'outbox', expectedOwner: record.owner });

  assert.equal(summary.scan.status, 'warn');
  assert.equal(summary.records.ready, 0);
  assert.equal(summary.records.invalid, 1);
  assert.equal(summary.statuses.invalid, 1);
});

test('outbox diagnostics do not fall back to readFile when fd reading is unavailable', async () => {
  let reads = 0;
  const fsImpl = {
    lstat: async (path) => path === 'root'
      ? { isDirectory: () => true, isSymbolicLink: () => false }
      : { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 20 },
    readdir: async () => ['sample.json'],
    readFile: async () => { reads += 1; return JSON.stringify({ status: 'ready' }); }
  };

  const summary = await inspectStateDirectory('root', { kind: 'outbox', expectedOwner: 'a'.repeat(64), fsImpl });

  assert.equal(summary.scan.status, 'warn');
  assert.equal(summary.records.invalid, 1);
  assert.equal(summary.statuses.invalid, 1);
  assert.equal(reads, 0);
});

test('doctor argument parser keeps old flags and accepts explicit probes', () => {
  assert.deepEqual(parseDoctorArgs(['--json', '--capabilities', '--latest', '--models', '--harness', '{}']), {
    checkCapabilities: true, json: true, help: false, latest: true, models: true, harness: '{}'
  });
});

test('unresolved command configuration is redacted in offline and capability reports', async () => {
  for (const variable of ['AGY_COMMAND', 'BUZZ_CLI_COMMAND']) {
    for (const checkCapabilities of [false, true]) {
      const marker = 'FAKE_DOCTOR_SECRET_9f1';
      let spawned = 0;
      const report = await runDoctor({ env: { [variable]: marker }, checkCapabilities,
        fsImpl: { stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, access: async () => {} },
        spawnImpl: () => { spawned += 1; throw new Error('unresolved command must not execute'); } });
      assert.equal(JSON.stringify(report).includes(marker), false);
      assert.equal(spawned, 0);
    }
  }
});

test('state summary preserves a scan warning with no records', () => {
  assert.equal(stateSummaryStatus({ scan: { status: 'warn' }, records: {}, locks: {}, entries: { truncated: false } }), 'warn');
});
