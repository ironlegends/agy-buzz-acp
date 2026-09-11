import { inspectSteeringDiagnostics } from './steering-diagnostics.js';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, lstat, readdir, readFile, stat } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableCommandVariable, isBatchExecutablePath, resolveExecutable } from './executables.js';
import { listModels } from './models.js';
import { inspectStateDirectory, stateSummaryStatus } from './status.js';

const PACKAGE_METADATA = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const DOCTOR_VERSION = PACKAGE_METADATA.version;
export const DEFAULT_TIMEOUT_MS = 3000;
export const MAX_TIMEOUT_MS = 10000;
export const NODE_MINIMUM_MAJOR = 20;
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/ironlegends/agy-buzz-acp/releases/latest';
export const MAX_HARNESS_BYTES = 64 * 1024;
export const MAX_RELEASE_BODY_BYTES = 64 * 1024;

const SAFE_CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'
];
const OWNER_RE = /^[0-9a-f]{64}$/i;
function hasValue(env, key) {
  return typeof env[key] === 'string' && env[key].trim().length > 0;
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

function harnessPaths(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const paths = /^[A-Za-z]:[\\/]/.test(text) ? win32 : posix;
  return text && paths.isAbsolute(text) ? { value: paths.normalize(text), paths } : null;
}

function harnessBase(configured = true) {
  return { configured, status: configured ? 'fail' : 'pass', message: configured ? 'Harness configuration could not be verified' : 'No harness configuration was supplied',
    adapter: { version: null, configuredVersion: null, runningVersion: null, runningStatus: 'unknown' } };
}

async function inspectHarness(value, { fsImpl, cwd = process.cwd(), platform = process.platform }) {
  if (value === undefined || value === null) {
    return { report: harnessBase(false), env: {} };
  }
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) {
    return { report: { ...harnessBase(), message: 'Harness path is invalid or exceeds the diagnostic limit' }, env: {} };
  }
  const rawHarnessPath = harnessPaths(value);
  const filePaths = rawHarnessPath?.paths ?? (platform === 'win32' ? win32 : posix);
  const harnessPath = rawHarnessPath ?? { value: filePaths.resolve(cwd, value.trim()), paths: filePaths };
  let harness;
  try {
    const details = await fsImpl.lstat(harnessPath.value);
    if (details?.isSymbolicLink?.() || details?.isFile?.() === false) {
      return { report: { ...harnessBase(), message: 'Harness file is not a regular file' }, env: {} };
    }
    if (Number.isFinite(details?.size) && details.size > MAX_HARNESS_BYTES) {
      return { report: { ...harnessBase(), message: 'Harness file exceeds the diagnostic size limit' }, env: {} };
    }
    harness = JSON.parse(await fsImpl.readFile(harnessPath.value, 'utf8'));
  } catch {
    return { report: { ...harnessBase(), message: 'Harness file could not be read safely' }, env: {} };
  }
  if (!harness || typeof harness !== 'object' || Array.isArray(harness)) {
    return { report: { ...harnessBase(), message: 'Harness configuration must be a JSON object' }, env: {} };
  }
  const args = Array.isArray(harness.args) ? harness.args : [];
  const env = harness.env && typeof harness.env === 'object' && !Array.isArray(harness.env) ? harness.env : {};
  const node = harnessPaths(harness.command ?? harness.nodePath);
  const adapter = harnessPaths(args[0]);
  const agy = harnessPaths(env.AGY_COMMAND);
  const buzz = harnessPaths(env.BUZZ_CLI_COMMAND);
  const nodeName = node && node.paths.basename(node.value).toLowerCase();
  const adapterName = adapter && adapter.paths.basename(adapter.value).toLowerCase();
  const adapterDir = adapter && adapter.paths.basename(adapter.paths.dirname(adapter.value)).toLowerCase();
  const shapeValid = Boolean(typeof harness.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(harness.id) && node && ['node', 'node.exe'].includes(nodeName) &&
    adapter && adapterName === 'agy-buzz-acp.js' && adapterDir === 'bin' && args.length === 1 &&
    typeof harness.command === 'string' && agy && buzz);
  if (!shapeValid) return { report: { ...harnessBase(), message: 'Harness is not a supported agy-buzz-acp setup document' }, env };

  let configuredVersion = null;
  try {
    const packagePath = adapter.paths.join(adapter.paths.dirname(adapter.value), '..', 'package.json');
    const packageDetails = await fsImpl.lstat(packagePath);
    if (packageDetails?.isSymbolicLink?.() || packageDetails?.isFile?.() === false ||
        (Number.isFinite(packageDetails?.size) && packageDetails.size > MAX_HARNESS_BYTES)) {
      throw new Error('unsafe package metadata');
    }
    const metadata = JSON.parse(await fsImpl.readFile(packagePath, 'utf8'));
    if (metadata?.name === 'agy-buzz-acp' && typeof metadata.version === 'string' &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) configuredVersion = metadata.version;
  } catch {
    configuredVersion = null;
  }
  return { report: {
    configured: true, status: configuredVersion ? 'pass' : 'warn',
    message: configuredVersion ? 'Harness paths and configured package metadata were verified' : 'Harness paths were verified; configured package version is unknown',
    adapter: { version: configuredVersion, configuredVersion, runningVersion: null, runningStatus: 'unknown' },
    paths: { nodePath: node.value, adapterPath: adapter.value, agyPath: agy.value, buzzPath: buzz.value },
    model: typeof env.AGY_MODEL === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(env.AGY_MODEL) ? env.AGY_MODEL : null
  }, env };
}

async function inspectLatestRelease({ fetchImpl, timeoutMs }) {
  const result = { requested: true, status: 'warn', version: null, source: LATEST_RELEASE_URL,
    message: 'Latest release could not be verified' };
  if (typeof fetchImpl !== 'function') {
    result.message = 'Latest release lookup is unavailable in this runtime';
    return result;
  }
  const controller = new AbortController();
  let timeoutReject;
  const timeout = new Promise((_, reject) => { timeoutReject = reject; });
  const timer = setTimeout(() => { controller.abort(); timeoutReject(new Error('timeout')); }, timeoutMs);
  try {
    const request = fetchImpl(LATEST_RELEASE_URL, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agy-buzz-doctor' },
      signal: controller.signal
    });
    const response = await Promise.race([request, timeout]);
    if (!response?.ok) return result;
    const body = await Promise.race([readReleaseBody(response), timeout]);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RELEASE_BODY_BYTES) return result;
    const data = JSON.parse(body);
    const tag = typeof data?.tag_name === 'string' ? data.tag_name.trim().replace(/^v/i, '') : '';
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) return result;
    return { ...result, status: 'pass', version: tag, message: 'Latest release was verified from GitHub' };
  } catch {
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function readReleaseBody(response) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = Buffer.from(part.value ?? '');
        size += chunk.length;
        if (size > MAX_RELEASE_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      reader.releaseLock?.();
    }
  }
  if (typeof response?.text === 'function') return response.text();
  if (typeof response?.json === 'function') return JSON.stringify(await response.json());
  return null;
}

async function inspectModels({ command, cwd, env, spawnImpl, timeoutMs }) {
  if (!command) return { requested: true, status: 'fail', models: [], message: 'AGY executable is unavailable for model discovery' };
  const modelSpawn = (executable, args, options) => spawnImpl(executable, args, { ...options, env: safeChildEnv(env) });
  const models = await listModels({ command, cwd, spawnFn: modelSpawn, timeoutMs });
  return { requested: true, status: models.length > 0 ? 'pass' : 'warn', models,
    message: models.length > 0 ? 'Official model catalog was queried' : 'Official model catalog returned no usable models' };
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
  const name = variable === executableCommandVariable.agy ? 'agy' : 'buzz';
  const executable = await resolveExecutable({ name, env, platform, fsImpl });
  const rejected = configured && isBatchExecutablePath(command, platform);
  let status = rejected ? 'fail' : executable ? 'pass' : configured ? 'fail' : 'warn';
  let message = rejected
    ? `${variable} points to a Windows batch shim; configure an executable path for shell-free diagnostics`
    : executable
    ? `${variable} resolves to ${executable.path}`
    : configured
      ? `${variable} is configured but its executable was not found`
      : `${variable} is not configured; install or configure ${defaultCommand} before starting a session`;
  const capabilities = {};
  if (checkCapabilities && nodeSupported && !rejected && executable) {
    const safeFlags = variable === 'BUZZ_CLI_COMMAND' ? ['--help'] : ['--version', '--help'];
    for (const flag of safeFlags) {
      const result = await capabilityCheck(executable?.path ?? command, flag, { cwd, env, timeoutMs, spawnImpl });
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
  return { command: executable?.path ?? null, configured, path: executable?.path ?? null, source: executable?.source ?? null, status, message, ...(checkCapabilities ? { capabilities } : {}) };
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
    const details = await (fsImpl.lstat ?? fsImpl.stat)(env[directoryKey]);
    if (details?.isSymbolicLink?.()) return { configured: true, status: 'warn', message: `${label} directory is a symbolic link; diagnostics will not follow it` };
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

async function inspectState(env, fsImpl, platform, { processAliveImpl } = {}) {
  const sessionConfigured = hasValue(env, 'AGY_SESSION_DIR') || hasValue(env, 'AGY_SESSION_OWNER');
  const sessionRelay = inspectSessionRelay(env, sessionConfigured);
  const stores = {
    outbox: await inspectStore(env, 'AGY_OUTBOX_DIR', 'AGY_OUTBOX_OWNER', 'Delivery outbox', fsImpl, platform),
    session: await inspectStore(env, 'AGY_SESSION_DIR', 'AGY_SESSION_OWNER', 'Session state', fsImpl, platform)
  };
  if (sessionRelay.status === 'fail') {
    stores.session = { ...stores.session, configured: true, status: 'fail', message: `${stores.session.message}; ${sessionRelay.message}` };
  }
  for (const [name, key] of [['outbox', 'AGY_OUTBOX_DIR'], ['session', 'AGY_SESSION_DIR']]) {
    const store = stores[name];
    if (!store.configured || store.status === 'fail') continue;
    const summary = await inspectStateDirectory(env[key], { kind: name, fsImpl, processAliveImpl });
    store.records = summary.records;
    store.locks = summary.locks;
    if (summary.statuses) {
      store.statuses = summary.statuses;
    }
    store.scan = summary.scan;
    if (stateSummaryStatus(summary) === 'warn' && store.status === 'pass') store.status = 'warn';
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
  harness,
  latest = false,
  fetchImpl = globalThis.fetch,
  models = false,
  processAliveImpl
} = {}) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.min(Math.max(Number(timeoutMs), 1), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const harnessInfo = await inspectHarness(harness, { fsImpl: { lstat, readFile, ...fsImpl }, cwd, platform });
  const diagnosticEnv = { ...(harnessInfo.env ?? {}), ...env };
  const nodeMajor = parseNodeMajor(nodeVersion);
  const nodeSupported = Number.isInteger(nodeMajor) && nodeMajor >= NODE_MINIMUM_MAJOR;
  const nodeCheck = check(
    'node-version',
    nodeSupported ? 'pass' : 'fail',
    nodeSupported ? `Node.js ${nodeVersion} satisfies the >=${NODE_MINIMUM_MAJOR} requirement` : `Node.js ${nodeVersion} is unsupported; Node.js ${NODE_MINIMUM_MAJOR} or newer is required`,
    { version: String(nodeVersion), major: Number.isNaN(nodeMajor) ? null : nodeMajor, supported: nodeSupported }
  );
  const commands = {
    agy: await inspectCommand('agy-command', 'AGY_COMMAND', 'agy', { env: diagnosticEnv, platform, fsImpl, checkCapabilities, cwd, timeoutMs: boundedTimeoutMs, spawnImpl, nodeSupported }),
    buzz: await inspectCommand('buzz-command', 'BUZZ_CLI_COMMAND', 'buzz', { env: diagnosticEnv, platform, fsImpl, checkCapabilities, cwd, timeoutMs: boundedTimeoutMs, spawnImpl, nodeSupported })
  };
  const state = await inspectState(diagnosticEnv, { access, lstat, readdir, readFile, stat, ...fsImpl }, platform, { processAliveImpl });
  const checks = [nodeCheck,
    check('agy-command', commands.agy.status, commands.agy.message),
    check('buzz-command', commands.buzz.status, commands.buzz.message),
    check('optional-state', state.status, state.message)];
  const relayConfigured = hasValue(diagnosticEnv, 'BUZZ_RELAY_URL') || hasValue(diagnosticEnv, 'AGY_RELAY_URL');
  const relay = { configured: relayConfigured, status: state.sessionRelay.status, message: state.sessionRelay.status === 'fail'
    ? state.sessionRelay.message
    : relayConfigured ? 'Relay URL is configured; this does not enable persistence' : 'No relay URL is configured' };
  checks.push(check('session-relay', relay.status, relay.message));
  const report = { doctorVersion: DOCTOR_VERSION, mode: checkCapabilities ? 'capabilities' : 'offline', platform, cwd, ok: false,
    node: nodeCheck, adapter: { configuredVersion: harnessInfo.report.adapter?.configuredVersion ?? null, runningVersion: null, runningStatus: 'unknown' },
    commands, state, relay, checks, harness: harnessInfo.report };
  report.checks.push(check('harness', report.harness.status, report.harness.message));
  if (latest) {
    report.latest = await inspectLatestRelease({ fetchImpl, timeoutMs: boundedTimeoutMs });
    report.checks.push(check('latest-release', report.latest.status, report.latest.message));
    report.mode = 'online';
  }
  if (models) {
    report.models = await inspectModels({ command: commands.agy.path ?? null, cwd, env: diagnosticEnv, spawnImpl, timeoutMs: boundedTimeoutMs });
    report.checks.push(check('models', report.models.status, report.models.message));
    report.mode = 'models';
  }
  report.steering = await inspectSteeringDiagnostics(diagnosticEnv, { fsImpl: { access, lstat, readdir, readFile, stat, ...fsImpl } });
  report.checks.push(check('steering-state', report.steering.status, report.steering.message));
  report.ok = report.checks.every(({ status }) => status !== 'fail');
  return report;
}

export function parseDoctorArgs(argv) {
  const options = { checkCapabilities: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--capabilities') options.checkCapabilities = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--latest') options.latest = true;
    else if (argument === '--models') options.models = true;
    else if (argument === '--harness') {
      if (index + 1 >= argv.length) throw new Error('--harness requires a JSON file path');
      options.harness = argv[++index];
    }
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
    `Harness: ${report.harness.status} — ${report.harness.message}`,
    ...(report.latest ? [`Latest release: ${report.latest.status} — ${report.latest.version ?? 'unknown'}`] : []),
    ...(report.models ? [`Models: ${report.models.status} — ${report.models.models.length} usable model(s)`] : []),
    ...(report.steering?.configured ? [`Steering: ${report.steering.status} — ${report.steering.message}`,
      `Steering bridges: ready=${report.steering.bridges.ready}, blocked=${report.steering.bridges.blocked}, invalid=${report.steering.bridges.invalid}, archived=${report.steering.bridges.archived}`, report.steering.guidance].filter(Boolean) : []),
    `Result: ${report.ok ? report.steering?.status === 'warn' ? 'checks completed with steering warnings; review before recovery' : 'ready for the reported checks' : 'action required'}`
  ];
  return `${lines.join('\n')}\n`;
}

export function doctorUsage() {
  return [
    'Usage: agy-buzz-doctor [--json] [--capabilities] [--harness JSON_FILE] [--latest] [--models]',
    '',
    'Run read-only offline diagnostics for the agy-buzz-acp adapter.',
    'Use --capabilities only when safe AGY --version and AGY/Buzz --help checks are explicitly wanted.',
    'Use --harness with a setup JSON file to inspect configured paths and package metadata.',
    'Use --latest for an explicit bounded GitHub release lookup; it is offline by default.',
    'Use --models for an explicit bounded official agy model catalog query.',
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
