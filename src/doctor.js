import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCTOR_VERSION = '0.2.0';
export const DEFAULT_TIMEOUT_MS = 3000;
export const MAX_TIMEOUT_MS = 10000;
export const NODE_MINIMUM_MAJOR = 20;

const SAFE_CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'
];
const OWNER_RE = /^[0-9a-f]{64}$/i;
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function hasValue(env, key) {
  return typeof env[key] === 'string' && env[key].trim().length > 0;
}

function commandUsesPath(command) {
  return isAbsolute(command) || command.includes('/') || command.includes('\\');
}

function isBatchShim(command, platform) {
  if (platform !== 'win32') return false;
  const extension = command.slice(command.lastIndexOf('.')).toLowerCase();
  return BATCH_EXTENSIONS.has(extension);
}

function commandCandidates(command, env, platform) {
  if (commandUsesPath(command)) return [command];
  const pathEntries = (env.PATH || '').split(delimiter).filter(Boolean);
  if (platform !== 'win32') return pathEntries.map((entry) => join(entry, command));
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    .filter((extension) => !BATCH_EXTENSIONS.has(extension.toLowerCase()));
  const names = command.includes('.') ? [command] : [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
  return pathEntries.flatMap((entry) => names.map((name) => join(entry, name)));
}

async function inspectExecutable(command, env, platform, fsImpl) {
  const candidates = commandCandidates(command, env, platform);
  const rejected = isBatchShim(command, platform);
  for (const candidate of candidates) {
    if (isBatchShim(candidate, platform)) continue;
    try {
      const details = await fsImpl.stat(candidate);
      if (!details.isFile()) continue;
      if (platform !== 'win32') await fsImpl.access(candidate, fsConstants.X_OK);
      return { found: true, path: candidate, rejected: false };
    } catch {
      // Continue through PATH candidates without exposing filesystem errors.
    }
  }
  return { found: false, path: null, rejected };
}

function safeChildEnv(env) {
  return Object.fromEntries(SAFE_CHILD_ENV_KEYS.filter((key) => hasValue(env, key)).map((key) => [key, env[key]]));
}

function parseNodeMajor(version) {
  const match = /^v?(\d+)/.exec(String(version));
  return match ? Number(match[1]) : NaN;
}

function check(id, status, message, details = {}) {
  return { id, status, message, ...details };
}

function canonicalRelay(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function inspectSessionRelay(env, sessionConfigured) {
  if (!sessionConfigured) return { configured: false, status: 'pass', message: 'Session relay prerequisite is inactive' };
  if (!hasValue(env, 'BUZZ_RELAY_URL')) {
    return { configured: false, status: 'fail', message: 'BUZZ_RELAY_URL is required when durable session state is enabled' };
  }
  const buzzRelay = canonicalRelay(env.BUZZ_RELAY_URL);
  if (!buzzRelay) return { configured: true, status: 'fail', message: 'BUZZ_RELAY_URL is malformed or contains unsupported credentials' };
  if (!hasValue(env, 'AGY_RELAY_URL')) return { configured: true, status: 'pass', message: 'BUZZ_RELAY_URL is valid for durable session state' };
  const agyRelay = canonicalRelay(env.AGY_RELAY_URL);
  if (!agyRelay) return { configured: true, status: 'fail', message: 'AGY_RELAY_URL is malformed or contains unsupported credentials' };
  if (agyRelay !== buzzRelay) return { configured: true, status: 'fail', message: 'AGY_RELAY_URL must match BUZZ_RELAY_URL including its query' };
  return { configured: true, status: 'pass', message: 'AGY_RELAY_URL matches BUZZ_RELAY_URL including its query' };
}

async function capabilityCheck(command, flag, { cwd, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(command, [flag], {
        cwd,
        env: safeChildEnv(env),
        shell: false,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      finish({ status: 'fail', message: `${command} could not be started for ${flag}` });
      return;
    }
    child?.stdout?.on?.('data', () => {});
    child?.stderr?.on?.('data', () => {});
    timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch { /* The diagnostic remains bounded. */ }
      finish({ status: 'fail', message: `${command} ${flag} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child?.once?.('error', () => finish({ status: 'fail', message: `${command} ${flag} could not be started` }));
    child?.once?.('close', (code) => finish(code === 0
      ? { status: 'pass', message: `${command} ${flag} completed` }
      : { status: 'fail', message: `${command} ${flag} exited unsuccessfully` }));
    if (!child?.once) finish({ status: 'fail', message: `${command} ${flag} did not return a process handle` });
  });
}

async function inspectCommand(id, variable, defaultCommand, { env, platform, fsImpl, checkCapabilities, cwd, timeoutMs, spawnImpl, nodeSupported }) {
  const configured = hasValue(env, variable);
  const command = configured ? env[variable].trim() : defaultCommand;
  const executable = await inspectExecutable(command, env, platform, fsImpl);
  let status = executable.rejected ? 'fail' : executable.found ? 'pass' : configured ? 'fail' : 'warn';
  let message = executable.rejected
    ? `${variable} points to a Windows batch shim; configure an executable path for shell-free diagnostics`
    : executable.found
    ? `${variable} resolves to ${executable.path}`
    : configured
      ? `${variable} is configured but ${command} was not found`
      : `${variable} is not configured; install or configure ${defaultCommand} before starting a session`;
  const capabilities = {};
  if (checkCapabilities && nodeSupported && !executable.rejected) {
    const safeFlags = variable === 'BUZZ_CLI_COMMAND' ? ['--help'] : ['--version', '--help'];
    for (const flag of safeFlags) {
      const result = await capabilityCheck(command, flag, { cwd, env, timeoutMs, spawnImpl });
      capabilities[flag.slice(2)] = result;
      if (result.status === 'fail') {
        status = 'fail';
        message = `${variable} capability check failed`;
      } else {
        status = 'pass';
        message = `${variable} responds to safe capability checks`;
      }
    }
  }
  return { command, configured, path: executable.path, status, message, ...(checkCapabilities ? { capabilities } : {}) };
}

async function inspectStore(env, directoryKey, ownerKey, label, fsImpl, platform) {
  const directoryConfigured = hasValue(env, directoryKey);
  const ownerConfigured = hasValue(env, ownerKey);
  if (!directoryConfigured && !ownerConfigured) {
    return { configured: false, status: 'pass', message: `${label} is disabled` };
  }
  if (!directoryConfigured || !ownerConfigured) {
    return { configured: true, status: 'fail', message: `${directoryKey} and ${ownerKey} must be configured together` };
  }
  if (!OWNER_RE.test(env[ownerKey])) {
    return { configured: true, status: 'fail', message: `${ownerKey} must contain 64 hexadecimal characters` };
  }
  try {
    const details = await fsImpl.stat(env[directoryKey]);
    if (!details.isDirectory()) return { configured: true, status: 'fail', message: `${directoryKey} is not a directory` };
    try {
      await fsImpl.access(env[directoryKey], fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      return { configured: true, status: 'fail', message: `${directoryKey} is not readable and writable by this process` };
    }
    if (platform === 'win32') {
      return { configured: true, status: 'warn', message: `${label} directory is available; verify private Windows ACLs separately` };
    }
    const mode = typeof details.mode === 'number' ? details.mode & 0o777 : null;
    if (mode !== null && (mode & 0o077) !== 0) {
      return { configured: true, status: 'warn', message: `${label} directory has group or world access bits; tighten permissions before enabling persistence` };
    }
    return { configured: true, status: 'pass', message: `${label} directory is available with private POSIX mode` };
  } catch {
    return { configured: true, status: 'warn', message: `${directoryKey} does not exist yet; the adapter will not create it during diagnostics` };
  }
}

async function inspectState(env, fsImpl, platform) {
  const sessionConfigured = hasValue(env, 'AGY_SESSION_DIR') || hasValue(env, 'AGY_SESSION_OWNER');
  const sessionRelay = inspectSessionRelay(env, sessionConfigured);
  const stores = {
    outbox: await inspectStore(env, 'AGY_OUTBOX_DIR', 'AGY_OUTBOX_OWNER', 'Delivery outbox', fsImpl, platform),
    session: await inspectStore(env, 'AGY_SESSION_DIR', 'AGY_SESSION_OWNER', 'Session state', fsImpl, platform)
  };
  if (sessionRelay.status === 'fail') {
    stores.session = { ...stores.session, configured: true, status: 'fail', message: `${stores.session.message}; ${sessionRelay.message}` };
  }
  const configuredStores = Object.values(stores).filter(({ configured }) => configured);
  const status = Object.values(stores).some(({ status: storeStatus }) => storeStatus === 'fail')
    ? 'fail'
    : Object.values(stores).some(({ status: storeStatus }) => storeStatus === 'warn') ? 'warn' : 'pass';
  const message = configuredStores.length === 0
    ? 'Optional durable state is disabled'
    : Object.entries(stores).filter(([, store]) => store.configured).map(([name, store]) => `${name}: ${store.message}`).join('; ');
  return { configured: configuredStores.length > 0, status, message, stores, sessionRelay };
}

export async function runDoctor({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  fsImpl = { access, stat },
  spawnImpl = nodeSpawn,
  checkCapabilities = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.min(Math.max(Number(timeoutMs), 1), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const nodeMajor = parseNodeMajor(nodeVersion);
  const nodeSupported = Number.isInteger(nodeMajor) && nodeMajor >= NODE_MINIMUM_MAJOR;
  const nodeCheck = check(
    'node-version',
    nodeSupported ? 'pass' : 'fail',
    nodeSupported ? `Node.js ${nodeVersion} satisfies the >=${NODE_MINIMUM_MAJOR} requirement` : `Node.js ${nodeVersion} is unsupported; Node.js ${NODE_MINIMUM_MAJOR} or newer is required`,
    { version: String(nodeVersion), major: Number.isNaN(nodeMajor) ? null : nodeMajor, supported: nodeSupported }
  );
  const commands = {
    agy: await inspectCommand('agy-command', 'AGY_COMMAND', 'agy', { env, platform, fsImpl, checkCapabilities, cwd, timeoutMs: boundedTimeoutMs, spawnImpl, nodeSupported }),
    buzz: await inspectCommand('buzz-command', 'BUZZ_CLI_COMMAND', 'buzz', { env, platform, fsImpl, checkCapabilities, cwd, timeoutMs: boundedTimeoutMs, spawnImpl, nodeSupported })
  };
  const state = await inspectState(env, fsImpl, platform);
  const checks = [nodeCheck,
    check('agy-command', commands.agy.status, commands.agy.message),
    check('buzz-command', commands.buzz.status, commands.buzz.message),
    check('optional-state', state.status, state.message)];
  const relayConfigured = hasValue(env, 'BUZZ_RELAY_URL') || hasValue(env, 'AGY_RELAY_URL');
  const relay = { configured: relayConfigured, status: state.sessionRelay.status, message: state.sessionRelay.status === 'fail'
    ? state.sessionRelay.message
    : relayConfigured ? 'Relay URL is configured; this does not enable persistence' : 'No relay URL is configured' };
  checks.push(check('session-relay', relay.status, relay.message));
  const finalOk = checks.every(({ status }) => status !== 'fail');
  return { doctorVersion: DOCTOR_VERSION, mode: checkCapabilities ? 'capabilities' : 'offline', platform, cwd, ok: finalOk, node: nodeCheck, commands, state, relay, checks };
}

export function parseDoctorArgs(argv) {
  const options = { checkCapabilities: false, json: false, help: false };
  for (const argument of argv) {
    if (argument === '--capabilities') options.checkCapabilities = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version') options.version = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export function formatDoctorReport(report) {
  const lines = [
    `agy-buzz-doctor ${report.doctorVersion} (${report.mode}, ${report.platform})`,
    `Node.js: ${report.node.version} — ${report.node.supported ? 'supported' : 'unsupported'}`,
    `AGY_COMMAND: ${report.commands.agy.status} — ${report.commands.agy.message}`,
    `BUZZ_CLI_COMMAND: ${report.commands.buzz.status} — ${report.commands.buzz.message}`,
    `Optional state: ${report.state.status} — ${report.state.message}`,
    `Result: ${report.ok ? 'ready for the reported checks' : 'action required'}`
  ];
  return `${lines.join('\n')}\n`;
}

export function doctorUsage() {
  return [
    'Usage: agy-buzz-doctor [--json] [--capabilities]',
    '',
    'Run read-only offline diagnostics for the agy-buzz-acp adapter.',
    'Use --capabilities only when safe AGY --version and AGY/Buzz --help checks are explicitly wanted.',
    'Diagnostics never log credentials, prompts, environment dumps, or subprocess output.'
  ].join('\n');
}

export async function runDoctorCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const options = parseDoctorArgs(argv);
    if (options.help) {
      stdout.write(`${doctorUsage()}\n`);
      return 0;
    }
    if (options.version) {
      stdout.write(`${DOCTOR_VERSION}\n`);
      return 0;
    }
    const report = await runDoctor({ ...options, env });
    stdout.write(options.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`agy-buzz-doctor: ${error.message}\n`);
    return 2;
  }
}

function isEntrypoint() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isEntrypoint()) {
  process.exitCode = await runDoctorCli();
}
