import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { acquireNativeLock } from './native-lock.js';

const execFile = promisify(execFileCallback);
let windowsOwnerSidPromise;

export const STEERING_SCHEMA_VERSION = 1;
export const MAX_STEERING_TEXT_LENGTH = 16_384;
export const MAX_PENDING_STEERS = 8;
export const STEERING_LOCK_WAIT_MS = 2_000;
export const STEERING_WINDOWS_SUBPROCESS_TIMEOUT_MS = 2_000;

export function readBooleanFlag(value) {
  return value === true || value === '1' || value === 'true';
}

const OWNER_RE = /^[0-9a-f]{64}$/i;
const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONVERSATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STEER_RE = /^[0-9a-f-]{36}$/i;

// Windows ACL and identity checks are auxiliary safety checks. Keep their
// process lifetime bounded independently from the steering lock and provider
// turn deadlines. The optional runner is deliberately narrow so tests can
// exercise this helper with a real synthetic child without altering the
// production command paths.
export function runBoundedSubprocess(command, args = [], {
  timeoutMs = STEERING_WINDOWS_SUBPROCESS_TIMEOUT_MS,
  maxBuffer = 64 * 1024,
  windowsHide = true,
  env
} = {}, execFileFn = execFile) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(maxBuffer) || maxBuffer < 1 || typeof execFileFn !== 'function') {
    throw new TypeError('agy steering subprocess options are invalid');
  }
  return execFileFn(command, args, {
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer,
    windowsHide,
    ...(env ? { env } : {})
  });
}

function steeringError(message, code = 'AGY_STEER_PROTOCOL', cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, rpcMessage: message });
}

function requireString(value, pattern, message, code = 'AGY_STEER_INPUT') {
  if (typeof value !== 'string' || !pattern.test(value)) throw steeringError(message, code);
  return value;
}

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw steeringError('agy steering binding is invalid', 'AGY_STEER_BINDING');
  }
  const normalized = {
    ownerId: requireString(binding.ownerId, OWNER_RE, 'agy steering owner binding is invalid', 'AGY_STEER_BINDING'),
    channelId: requireString(binding.channelId, CHANNEL_RE, 'agy steering channel binding is invalid', 'AGY_STEER_BINDING'),
    sessionId: requireString(binding.sessionId, SESSION_RE, 'agy steering session binding is invalid', 'AGY_STEER_BINDING'),
    conversationId: requireString(binding.conversationId, CONVERSATION_RE, 'agy steering conversation binding is invalid', 'AGY_STEER_BINDING'),
    nonce: requireString(binding.nonce, /^[0-9a-f]{32}$/i, 'agy steering nonce is invalid', 'AGY_STEER_BINDING')
  };
  return Object.freeze(normalized);
}

function bindingToken(binding) {
  const { conversationId: _conversationId, ...stableBinding } = binding;
  return createHash('sha256').update(JSON.stringify(stableBinding)).digest('hex');
}

function normalizeRoot(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir.trim() || !isAbsolute(rootDir)) {
    throw steeringError('agy steering root directory is invalid', 'AGY_STEER_PATH');
  }
  return resolve(rootDir);
}

function normalizeBridgePath(bridgeDir) {
  if (typeof bridgeDir !== 'string' || !bridgeDir.trim() || !isAbsolute(bridgeDir)) {
    throw steeringError('agy steering bridge directory is invalid', 'AGY_STEER_PATH');
  }
  return resolve(bridgeDir);
}

async function assertNoSymlinkAncestors(target) {
  let current = resolve(target);
  const ancestors = [];
  while (true) {
    ancestors.push(current);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw steeringError('agy steering path must not contain a symlink', 'AGY_STEER_PATH');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of ancestors) {
    const stat = await lstat(path).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw steeringError('agy steering path must not contain a symlink', 'AGY_STEER_PATH');
  }
}

async function assertDirectory(dir) {
  const stat = await lstat(dir).catch((error) => {
    throw steeringError('agy steering bridge directory is unavailable', 'AGY_STEER_PATH', error);
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw steeringError('agy steering bridge directory must be a real directory', 'AGY_STEER_PATH');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw steeringError('agy steering bridge directory permissions are unsafe', 'AGY_STEER_PATH');
  }
}

async function windowsOwnerSid() {
  windowsOwnerSidPromise ??= runBoundedSubprocess('whoami', ['/user'], { maxBuffer: 16 * 1024 })
    .then(({ stdout }) => stdout.match(/S-1-\d+(?:-\d+)+/)?.[0] ?? null)
    .catch(() => null);
  const ownerSid = await windowsOwnerSidPromise;
  if (!ownerSid) throw steeringError('agy steering Windows owner identity is unavailable', 'AGY_STEER_PATH');
  return ownerSid;
}

async function readWindowsAccessRules(dir) {
  const script = [
    '$acl = [System.IO.DirectoryInfo]::new($env:AGY_STEER_ACL_PATH).GetAccessControl()',
    '$entries = @($acl.Access | ForEach-Object {',
    '  $sid = $_.IdentityReference.Value',
    '  try { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}',
    '  [pscustomobject]@{ sid = $sid; type = $_.AccessControlType.ToString(); inherited = [bool]$_.IsInherited; rights = $_.FileSystemRights.ToString() }',
    '})',
    '[pscustomobject]@{ entries = $entries } | ConvertTo-Json -Compress -Depth 5'
  ].join(';');
  try {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await runBoundedSubprocess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], {
      env: { ...process.env, AGY_STEER_ACL_PATH: dir },
      maxBuffer: 64 * 1024
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed.entries) ? parsed.entries : parsed.entries ? [parsed.entries] : [];
  } catch (error) {
    throw steeringError('agy steering Windows ACL could not be inspected', 'AGY_STEER_PATH', error);
  }
}

async function assertWindowsDirectoryPrivate(dir) {
  if (process.platform !== 'win32') return;
  const ownerSid = await windowsOwnerSid();
  const allowedSids = new Set([ownerSid, 'S-1-5-18', 'S-1-5-32-544']);
  const entries = await readWindowsAccessRules(dir);
  const present = new Set();
  for (const entry of entries) {
    if (entry.inherited || entry.type !== 'Allow' || !allowedSids.has(entry.sid) || !entry.rights.includes('FullControl')) {
      throw steeringError('agy steering Windows ACL contains an untrusted access rule', 'AGY_STEER_PATH');
    }
    present.add(entry.sid);
  }
  for (const sid of allowedSids) {
    if (!present.has(sid)) throw steeringError('agy steering Windows ACL is incomplete', 'AGY_STEER_PATH');
  }
}

async function protectWindowsDirectory(dir) {
  if (process.platform !== 'win32') return;
  const ownerSid = await windowsOwnerSid();
  try {
    await runBoundedSubprocess('icacls', [dir, '/inheritance:r', '/grant:r', `*${ownerSid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)'], { maxBuffer: 32 * 1024 });
  } catch (error) {
    throw steeringError('agy steering Windows ACL could not be protected', 'AGY_STEER_PATH', error);
  }
}

async function ensurePrivateDirectory(dir, { create = false, owned = false, validateExisting = true } = {}) {
  await assertNoSymlinkAncestors(dir);
  let created = false;
  const existing = await lstat(dir).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw steeringError('agy steering bridge directory could not be inspected safely', 'AGY_STEER_PATH', error);
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw steeringError('agy steering bridge directory must be a real directory', 'AGY_STEER_PATH');
  }
  if (!existing && create) {
    created = true;
  }
  if (create) {
    if (!existing) {
      try { await mkdir(dir, { recursive: true, mode: 0o700 }); }
      catch (error) { throw steeringError('agy steering directory could not be created safely', 'AGY_STEER_PATH', error); }
    }
  }
  await assertDirectory(dir);
  if (created || owned) {
    await chmod(dir, 0o700);
    await protectWindowsDirectory(dir);
    await assertDirectory(dir);
  } else if (validateExisting) {
    await assertWindowsDirectoryPrivate(dir);
  }
}

async function assertRegularFile(path) {
  const stat = await lstat(path).catch((error) => {
    throw steeringError('agy steering bridge file is unavailable', 'AGY_STEER_PROTOCOL', error);
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw steeringError('agy steering bridge file must be a regular file', 'AGY_STEER_PATH');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw steeringError('agy steering bridge file permissions are unsafe', 'AGY_STEER_PATH');
  }
}

async function replaceSteeringFile(source, destination) {
  const deadline = performance.now() + 500;
  let replaced = false;
  do {
    try { await rename(source, destination); replaced = true; }
    catch (error) {
      // Windows may transiently deny replacement while another reader closes.
      // Retry only the failed atomic rename, never the enclosing state transition.
      const remaining = deadline - performance.now();
      if (process.platform !== 'win32' ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || remaining <= 0) throw error;
      await pause(Math.min(20, remaining));
    }
  } while (!replaced);
}

async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const existing = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw steeringError('agy steering bridge file could not be inspected safely', 'AGY_STEER_PATH', error);
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
      process.platform !== 'win32' && (existing.mode & 0o077) !== 0)) {
    throw steeringError('agy steering bridge file must be a regular file', 'AGY_STEER_PATH');
  }
  const temporary = join(parent, `.${parse(path).name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await replaceSteeringFile(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      throw steeringError('agy steering bridge file could not be replaced safely', 'AGY_STEER_PATH', error);
    }
    throw steeringError('agy steering bridge file could not be written', 'AGY_STEER_PROTOCOL', error);
  }
}

async function readJson(path) {
  await assertRegularFile(path);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code?.startsWith?.('AGY_STEER_')) throw error;
    throw steeringError('agy steering bridge record is corrupted', 'AGY_STEER_PROTOCOL', error);
  }
}

function assertToken(value, expected) {
  if (typeof value !== 'string' || value !== expected) {
    throw steeringError('agy steering binding token mismatch', 'AGY_STEER_BINDING_MISMATCH');
  }
}

function validateProviderInput(input, expectedConversationId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw steeringError('agy steering provider metadata is invalid', 'AGY_STEER_PROVIDER');
  }
  if (input.conversationId !== expectedConversationId) {
    throw steeringError('agy steering provider conversation mismatch', 'AGY_STEER_BINDING_MISMATCH');
  }
  if (!Number.isInteger(input.invocationNum) || input.invocationNum < 0 || input.invocationNum > 1_000_000) {
    throw steeringError('agy steering provider invocation metadata is invalid', 'AGY_STEER_PROVIDER');
  }
  if (input.workspacePaths !== undefined && (!Array.isArray(input.workspacePaths) || input.workspacePaths.length !== 0)) {
    throw steeringError('agy steering provider workspace scope is invalid', 'AGY_STEER_BINDING_MISMATCH');
  }
  return { conversationId: input.conversationId, invocationNum: input.invocationNum };
}

function validateQueueEntry(entry) {
  if (!entry || typeof entry !== 'object' || !STEER_RE.test(entry.steerId ?? '') ||
      !Number.isInteger(entry.sequence) || entry.sequence < 1 ||
      !Number.isInteger(entry.claimFloorStep) || entry.claimFloorStep < 0 ||
      entry.requestFile !== `${entry.steerId}.request.json` ||
      !['queued', 'awaiting_user_input', 'injected', 'blocked'].includes(entry.status)) {
    throw steeringError('agy steering state is corrupted', 'AGY_STEER_PROTOCOL');
  }
  return entry;
}

function validateState(state, binding) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.schemaVersion !== STEERING_SCHEMA_VERSION ||
      !['ready', 'queued', 'claimed', 'injected', 'blocked'].includes(state.status) ||
      typeof state.guardBlocked !== 'boolean' ||
      (state.activeSteerId !== null && !STEER_RE.test(state.activeSteerId ?? '')) ||
      !Array.isArray(state.queue) || !Number.isInteger(state.nextSequence) || state.nextSequence < 1 ||
      state.bindingToken !== bindingToken(binding)) {
    throw steeringError('agy steering state is corrupted', 'AGY_STEER_PROTOCOL');
  }
  for (const entry of state.queue) validateQueueEntry(entry);
  if (state.status === 'claimed' && !state.activeSteerId) {
    throw steeringError('agy steering state is corrupted', 'AGY_STEER_PROTOCOL');
  }
  return state;
}

function validateRequest(request, binding, entry) {
  if (!request || typeof request !== 'object' || request.schemaVersion !== STEERING_SCHEMA_VERSION ||
      request.bindingToken !== bindingToken(binding) || request.conversationId !== binding.conversationId ||
      request.steerId !== entry.steerId || request.sequence !== entry.sequence ||
      request.claimFloorStep !== entry.claimFloorStep || typeof request.text !== 'string' ||
      request.text.length === 0 || request.text.length > MAX_STEERING_TEXT_LENGTH ||
      !['queued', 'awaiting_user_input', 'injected', 'blocked'].includes(request.status)) {
    throw steeringError('agy steering request is corrupted', 'AGY_STEER_PROTOCOL');
  }
  return request;
}

function validateAck(ack, binding, entry) {
  if (!ack || typeof ack !== 'object' || ack.schemaVersion !== STEERING_SCHEMA_VERSION ||
      ack.bindingToken !== bindingToken(binding) || ack.conversationId !== binding.conversationId ||
      ack.steerId !== entry.steerId || ack.sequence !== entry.sequence ||
      ack.status !== 'injected' || !Number.isInteger(ack.invocationNum) || ack.invocationNum < 0) {
    throw steeringError('agy steering acknowledgement is invalid', 'AGY_STEER_PROTOCOL');
  }
  return ack;
}

async function withBridgeLock(bridgeDir, callback, { waitMs = STEERING_LOCK_WAIT_MS } = {}) {
  await ensurePrivateDirectory(bridgeDir);
  const deadline = performance.now() + waitMs;
  let lock;
  // Only a pre-mutation lock collision may be retried. Ownership, ACL, scope,
  // corrupt state and errors from the protected callback remain fail-closed.
  do {
    try { lock = await acquireNativeLock(join(bridgeDir, '.steering.lock')); }
    catch (error) {
      const remaining = deadline - performance.now();
      if (error?.code !== 'AGY_NATIVE_LOCK_BUSY' || remaining <= 0) throw error;
      await pause(Math.min(20, remaining));
    }
  } while (!lock);
  try { return await callback(); }
  finally { await lock.release(); }
}

async function loadBinding(bridgeDir) {
  await ensurePrivateDirectory(bridgeDir);
  const binding = validateBinding(await readJson(join(bridgeDir, 'binding.json')));
  return { binding, token: bindingToken(binding) };
}

async function blockState(bridgeDir, state, reason) {
  const blocked = {
    ...state,
    status: 'blocked',
    guardBlocked: true,
    activeSteerId: null,
    queue: state.queue.map((entry) => ({ ...entry, status: 'blocked' })),
    blockedReason: String(reason || 'agy steering protocol became uncertain').slice(0, 256),
    updatedAt: Date.now()
  };
  await writeJsonAtomic(join(bridgeDir, 'state.json'), blocked);
  for (const entry of state.queue) {
    const requestPath = join(bridgeDir, entry.requestFile);
    try {
      const request = await readJson(requestPath);
      await writeJsonAtomic(requestPath, { ...request, status: 'blocked' });
    } catch { /* The state sentinel remains authoritative if a request is missing. */ }
  }
  return blocked;
}

export async function claimPendingSteer({ bridgeDir, bindingToken: expectedToken, input }) {
  const path = normalizeBridgePath(bridgeDir);
  const preflight = await loadBinding(path);
  assertToken(expectedToken, preflight.token);
  return withBridgeLock(path, async () => {
    const { binding, token } = await loadBinding(path);
    assertToken(expectedToken, token);
    const metadata = validateProviderInput(input, binding.conversationId);
    const state = validateState(await readJson(join(path, 'state.json')), binding);
    if (state.status === 'blocked' || !state.guardBlocked && state.queue.length === 0) return {};
    if (state.activeSteerId || state.queue.some((entry) => entry.status === 'awaiting_user_input')) return {};
    const entry = state.queue.find((candidate) => candidate.status === 'queued');
    if (!entry) return {};
    const requestPath = join(path, entry.requestFile);
    let request;
    try { request = validateRequest(await readJson(requestPath), binding, entry); }
    catch {
      await blockState(path, state, 'steering request could not be validated');
      return {};
    }
    if (request.status !== 'queued') {
      await blockState(path, state, 'steering request status is ambiguous');
      return {};
    }
    const ackPath = join(path, `${entry.steerId}.ack.json`);
    const existingAck = await lstat(ackPath).catch(() => null);
    if (existingAck) {
      await blockState(path, state, 'steering acknowledgement was already present');
      return {};
    }

    const claimedState = {
      ...state,
      status: 'claimed',
      guardBlocked: true,
      activeSteerId: entry.steerId,
      queue: state.queue.map((candidate) => candidate.steerId === entry.steerId
        ? { ...candidate, status: 'awaiting_user_input' } : candidate),
      updatedAt: Date.now()
    };
    // Persist the claim before making the request visible as awaiting input.
    await writeJsonAtomic(join(path, 'state.json'), claimedState);
    await writeJsonAtomic(requestPath, { ...request, status: 'awaiting_user_input', invocationNum: metadata.invocationNum });
    await writeJsonAtomic(ackPath, {
      schemaVersion: STEERING_SCHEMA_VERSION,
      bindingToken: token,
      conversationId: binding.conversationId,
      steerId: entry.steerId,
      sequence: entry.sequence,
      invocationNum: metadata.invocationNum,
      status: 'injected'
    });
    return { injectSteps: [{ userMessage: request.text }], terminationBehavior: 'force_continue' };
  });
}

export async function runSteeringHook({ input, env = process.env } = {}) {
  try {
    const bridgeDir = env?.AGY_STEER_BRIDGE_DIR;
    const expectedToken = env?.AGY_STEER_BINDING;
    if (typeof bridgeDir !== 'string' || typeof expectedToken !== 'string') return {};
    return await claimPendingSteer({ bridgeDir, bindingToken: expectedToken, input });
  } catch {
    return {};
  }
}

export async function inspectSteeringBridge({ bridgeDir, ownerId, channelId } = {}) {
  const path = normalizeBridgePath(bridgeDir);
  const existing = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) return { exists: false, blocked: false };
  await ensurePrivateDirectory(path, { validateExisting: true });
  const savedBinding = validateBinding(await readJson(join(path, 'binding.json')));
  requireString(ownerId, OWNER_RE, 'agy steering owner binding is invalid', 'AGY_STEER_BINDING');
  requireString(channelId, CHANNEL_RE, 'agy steering channel binding is invalid', 'AGY_STEER_BINDING');
  if (savedBinding.ownerId.toLowerCase() !== ownerId.toLowerCase() || savedBinding.channelId.toLowerCase() !== channelId.toLowerCase()) {
    throw steeringError('agy steering bridge binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
  }
  const state = validateState(await readJson(join(path, 'state.json')), savedBinding);
  return { exists: true, blocked: state.status === 'blocked' || state.guardBlocked };
}

// Archive a bridge whose durable state is blocked, so the next turn builds a fresh
// one. The caller proves the block is orphaned: this process holds the session
// ownership lock, and no turn of this adapter is running on the channel. The old
// directory is renamed, never deleted, so the orphaned steer stays readable.
export async function reconcileSteeringBridge({ bridgeDir, ownerId, channelId, nowFn = Date.now } = {}) {
  const status = await inspectSteeringBridge({ bridgeDir, ownerId, channelId });
  if (!status.exists || !status.blocked) return { reconciled: false, archivedTo: null };
  const path = normalizeBridgePath(bridgeDir);
  const stamp = new Date(nowFn()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let target = `${path}-archived-${stamp}`;
  for (let suffix = 1; await lstat(target).catch(() => null); suffix += 1) {
    target = `${path}-archived-${stamp}-${suffix}`;
  }
  await rename(path, target);
  return { reconciled: true, archivedTo: target };
}

export class SteeringCoordinator {
  constructor({ bridgeDir, binding, enabled, hookConfigured, injectorExclusive, conversationBound = true } = {}) {
    this.bridgeDir = bridgeDir;
    this.binding = binding;
    this.enabled = Boolean(enabled && hookConfigured && injectorExclusive);
    this.hookConfigured = hookConfigured;
    this.injectorExclusive = injectorExclusive;
    this.conversationBound = conversationBound !== false;
    this.blocked = false;
    this.paths = {
      state: join(bridgeDir, 'state.json'),
      binding: join(bridgeDir, 'binding.json'),
      request: (steerId) => join(bridgeDir, `${steerId}.request.json`),
      ack: (steerId) => join(bridgeDir, `${steerId}.ack.json`)
    };
  }

  get bindingToken() {
    return this.enabled ? bindingToken(this.binding) : null;
  }

  bridgeEnv() {
    if (!this.enabled || this.blocked) return this.enabled ? {
      AGY_STEER_BRIDGE_DIR: this.bridgeDir,
      AGY_STEER_BINDING: this.bindingToken
    } : null;
    return { AGY_STEER_BRIDGE_DIR: this.bridgeDir, AGY_STEER_BINDING: this.bindingToken };
  }

  assertBinding(candidate = {}) {
    const fields = ['ownerId', 'channelId', 'sessionId', 'conversationId'];
    for (const field of fields) {
      if (field === 'conversationId' && !this.conversationBound) continue;
      if (candidate[field] !== undefined && candidate[field] !== this.binding[field]) {
        throw steeringError(`agy steering ${field} binding mismatch`, 'AGY_STEER_BINDING_MISMATCH');
      }
    }
    return true;
  }

  ensureUsable() {
    if (!this.enabled) throw steeringError('agy steering is disabled without an exclusive dedicated hook', 'AGY_STEER_UNAVAILABLE');
    if (this.blocked) throw steeringError('agy steering is durably blocked', 'AGY_STEER_BLOCKED');
    if (!this.conversationBound) throw steeringError('agy steering conversation is not confirmed', 'AGY_STEER_UNAVAILABLE');
  }

  async bindConversation(conversationId) {
    if (!this.enabled) throw steeringError('agy steering is disabled without an exclusive dedicated hook', 'AGY_STEER_UNAVAILABLE');
    requireString(conversationId, CONVERSATION_RE, 'agy steering conversation binding is invalid', 'AGY_STEER_BINDING');
    if (this.conversationBound) {
      if (conversationId !== this.binding.conversationId) throw steeringError('agy steering conversation binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
      return conversationId;
    }
    return withBridgeLock(this.bridgeDir, async () => {
      const { binding, token } = await loadBinding(this.bridgeDir);
      if (binding.ownerId !== this.binding.ownerId || binding.channelId !== this.binding.channelId ||
          binding.sessionId !== this.binding.sessionId || binding.nonce !== this.binding.nonce) {
        throw steeringError('agy steering bridge binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
      }
      if (binding.conversationId !== this.binding.conversationId) {
        if (binding.conversationId === conversationId) {
          this.binding = binding;
          this.conversationBound = true;
          return conversationId;
        }
        throw steeringError('agy steering conversation binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
      }
      const state = validateState(await readJson(this.paths.state), binding);
      if (state.status === 'blocked') {
        this.blocked = true;
        throw steeringError('agy steering is durably blocked', 'AGY_STEER_BLOCKED');
      }
      if (state.guardBlocked || state.queue.length > 0) {
        await blockState(this.bridgeDir, state, 'unconsumed steering claim found before conversation binding');
        this.blocked = true;
        throw steeringError('agy steering is durably blocked', 'AGY_STEER_BLOCKED');
      }
      const bound = Object.freeze({ ...binding, conversationId });
      await writeJsonAtomic(this.paths.binding, bound);
      await writeJsonAtomic(this.paths.state, { ...state, bindingToken: token, updatedAt: Date.now() });
      this.binding = bound;
      this.conversationBound = true;
      return conversationId;
    });
  }

  async snapshot() {
    if (!this.enabled) return { status: 'disabled', queue: [] };
    // State records are replaced atomically. Keep snapshot read-only so a live
    // helper can hold the native lock while it commits binding/state/request/ack.
    // Binding and ACL validation remain mandatory before trusting the record.
    const { binding } = await loadBinding(this.bridgeDir);
    if (bindingToken(binding) !== this.bindingToken || binding.conversationId !== this.binding.conversationId) {
      throw steeringError('agy steering bridge binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
    }
    const state = validateState(await readJson(this.paths.state), binding);
    if (state.status === 'blocked') this.blocked = true;
    return structuredClone(state);
  }

  async enqueue(text, { claimFloorStep } = {}) {
    this.ensureUsable();
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_STEERING_TEXT_LENGTH ||
        !Number.isInteger(claimFloorStep) || claimFloorStep < 0 || claimFloorStep > 1_000_000_000) {
      throw steeringError('agy steering request text or claim watermark is invalid', 'AGY_STEER_INPUT');
    }
    return withBridgeLock(this.bridgeDir, async () => {
      const state = validateState(await readJson(this.paths.state), this.binding);
      if (state.status === 'blocked') {
        this.blocked = true;
        throw steeringError('agy steering is durably blocked', 'AGY_STEER_BLOCKED');
      }
      const pending = state.queue.filter((entry) => ['queued', 'awaiting_user_input'].includes(entry.status));
      if (pending.length >= MAX_PENDING_STEERS) throw steeringError('agy steering queue is full', 'AGY_STEER_INPUT');
      const steerId = randomUUID();
      const entry = { steerId, sequence: state.nextSequence, claimFloorStep,
        requestFile: `${steerId}.request.json`, status: 'queued' };
      const nextState = {
        ...state,
        status: state.activeSteerId ? 'claimed' : 'queued',
        guardBlocked: true,
        queue: [...state.queue, entry],
        nextSequence: state.nextSequence + 1,
        updatedAt: Date.now()
      };
      // The durable blocked guard and watermark are committed before the request file.
      await writeJsonAtomic(this.paths.state, nextState);
      await writeJsonAtomic(this.paths.request(steerId), {
        schemaVersion: STEERING_SCHEMA_VERSION,
        bindingToken: this.bindingToken,
        conversationId: this.binding.conversationId,
        steerId,
        sequence: entry.sequence,
        claimFloorStep,
        status: 'queued',
        text
      });
      return { steerId, sequence: entry.sequence, status: 'queued', claimFloorStep };
    });
  }

  async observeUserInput({ conversationId, stepIndex } = {}) {
    this.ensureUsable();
    if (conversationId !== this.binding.conversationId || !Number.isInteger(stepIndex) || stepIndex < 0) {
      await this.block('foreign or invalid provider user_input');
      throw steeringError('agy steering provider user_input is ambiguous', 'AGY_STEER_BLOCKED');
    }
    return withBridgeLock(this.bridgeDir, async () => {
      const state = validateState(await readJson(this.paths.state), this.binding);
      if (state.status === 'blocked' || !state.activeSteerId) {
        this.blocked = state.status === 'blocked';
        throw steeringError('agy steering has no confirmable claim', 'AGY_STEER_BLOCKED');
      }
      const entry = state.queue.find((candidate) => candidate.steerId === state.activeSteerId);
      if (!entry || entry.status !== 'awaiting_user_input') {
        await blockState(this.bridgeDir, state, 'provider user_input claim is missing');
        this.blocked = true;
        throw steeringError('agy steering provider user_input is ambiguous', 'AGY_STEER_BLOCKED');
      }
      let request;
      try { request = validateRequest(await readJson(this.paths.request(entry.steerId)), this.binding, entry); }
      catch {
        await blockState(this.bridgeDir, state, 'steering request could not be validated');
        this.blocked = true;
        throw steeringError('agy steering provider user_input is ambiguous', 'AGY_STEER_BLOCKED');
      }
      if (request.status !== 'awaiting_user_input' || stepIndex <= entry.claimFloorStep) {
        await blockState(this.bridgeDir, state, 'provider user_input did not advance past claim watermark');
        this.blocked = true;
        throw steeringError('agy steering provider user_input is ambiguous', 'AGY_STEER_BLOCKED');
      }
      try { validateAck(await readJson(this.paths.ack(entry.steerId)), this.binding, entry); }
      catch {
        await blockState(this.bridgeDir, state, 'steering acknowledgement could not be validated');
        this.blocked = true;
        throw steeringError('agy steering provider user_input is ambiguous', 'AGY_STEER_BLOCKED');
      }
      const queue = state.queue.map((candidate) => candidate.steerId === entry.steerId
        ? { ...candidate, status: 'injected' } : candidate);
      const hasPending = queue.some((candidate) => candidate.status === 'queued' || candidate.status === 'awaiting_user_input');
      const nextState = {
        ...state,
        status: hasPending ? 'queued' : 'injected',
        guardBlocked: hasPending,
        activeSteerId: null,
        queue,
        lastInjectedSteerId: entry.steerId,
        lastInjectedStep: stepIndex,
        updatedAt: Date.now()
      };
      await writeJsonAtomic(this.paths.request(entry.steerId), { ...request, status: 'injected', userInputStep: stepIndex });
      await writeJsonAtomic(this.paths.state, nextState);
      return { outcome: 'injected', steerId: entry.steerId, sequence: entry.sequence, userInputStep: stepIndex };
    });
  }

  async block(reason) {
    if (!this.enabled) return false;
    return withBridgeLock(this.bridgeDir, async () => {
      const state = validateState(await readJson(this.paths.state), this.binding);
      if (state.status === 'blocked') {
        this.blocked = true;
        return false;
      }
      await blockState(this.bridgeDir, state, reason);
      this.blocked = true;
      return true;
    }, { waitMs: 0 });
  }
}

export async function createSteeringCoordinator({
  rootDir = join(tmpdir(), 'agy-buzz-steering'),
  bridgeDir,
  ownerId,
  channelId,
  sessionId,
  conversationId,
  injectorExclusive = false,
  hookConfigured = false,
  conversationBound = true
} = {}) {
  const binding = validateBinding({ ownerId, channelId, sessionId, conversationId, nonce: randomUUID().replaceAll('-', '') });
  if (!injectorExclusive || !hookConfigured) {
    return new SteeringCoordinator({ bridgeDir: '', binding, enabled: false, hookConfigured, injectorExclusive, conversationBound });
  }
  const root = normalizeRoot(rootDir);
  await ensurePrivateDirectory(root, { create: true, validateExisting: false });
  const path = bridgeDir ? normalizeBridgePath(bridgeDir) : await mkdtemp(join(root, 'agy-steer-'));
  await ensurePrivateDirectory(path, { create: true, owned: !bridgeDir });
  const token = bindingToken(binding);
  let effectiveBinding = binding;
  return withBridgeLock(path, async () => {
    const bindingPath = join(path, 'binding.json');
    const statePath = join(path, 'state.json');
    const hasBinding = await lstat(bindingPath).then(() => true).catch(() => false);
    if (!hasBinding) {
      await writeJsonAtomic(bindingPath, binding);
      await writeJsonAtomic(statePath, {
        schemaVersion: STEERING_SCHEMA_VERSION, bindingToken: token, status: 'ready', guardBlocked: false,
        activeSteerId: null, queue: [], nextSequence: 1, updatedAt: Date.now()
      });
    } else {
      const savedBinding = validateBinding(await readJson(bindingPath));
      if (savedBinding.ownerId !== binding.ownerId || savedBinding.channelId !== binding.channelId ||
          savedBinding.sessionId !== binding.sessionId || savedBinding.conversationId !== binding.conversationId) {
        throw steeringError('agy steering bridge binding mismatch', 'AGY_STEER_BINDING_MISMATCH');
      }
      const savedState = validateState(await readJson(statePath), savedBinding);
      if (savedState.status === 'blocked') {
        const coordinator = new SteeringCoordinator({ bridgeDir: path, binding: savedBinding, enabled: true, hookConfigured, injectorExclusive, conversationBound: true });
        coordinator.blocked = true;
        return coordinator;
      }
      if (savedState.guardBlocked || savedState.queue.some((entry) => ['queued', 'awaiting_user_input'].includes(entry.status))) {
        await blockState(path, savedState, 'unconsumed steering claim found during reopen');
        const coordinator = new SteeringCoordinator({ bridgeDir: path, binding: savedBinding, enabled: true, hookConfigured, injectorExclusive, conversationBound: true });
        coordinator.blocked = true;
        return coordinator;
      }
      effectiveBinding = savedBinding;
    }
    return new SteeringCoordinator({ bridgeDir: path, binding: effectiveBinding, enabled: true, hookConfigured, injectorExclusive, conversationBound });
  });
}

// Shared pure validation for offline diagnostics; does not acquire or mutate state.
export function validateSteeringSnapshot(binding, state) {
  validateState(state, validateBinding(binding));
}
