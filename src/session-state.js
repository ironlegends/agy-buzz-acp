import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireNativeLock } from './native-lock.js';

const OWNER_RE = /^[0-9a-f]{64}$/i;
const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RELAY_RE = /^(?:ws|wss|http|https):\/\/[^\s/]+(?:\/[^\s]*)?$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

function stateError(message, code = 'AGY_SESSION_STATE') {
  return Object.assign(new Error(message), { code, rpcMessage: message });
}

const OWNERSHIP_ERRORS = {
  AGY_SESSION_STATE_BUSY: 'the channel ownership lock is held elsewhere',
  AGY_SESSION_STATE_LEGACY_LOCK: 'a legacy channel lock requires controlled migration',
  AGY_SESSION_STATE_PERMISSIONS: 'channel ownership permissions are insufficient or unsafe',
  AGY_SESSION_STATE_SCOPE: 'channel ownership scope is invalid',
  AGY_SESSION_STATE_NATIVE_UNAVAILABLE: 'native channel locking is unavailable',
  AGY_SESSION_STATE_UNSAFE_LOCK: 'the channel lock path is unsafe',
  AGY_SESSION_STATE: 'channel ownership could not be established'
};

export function ownershipFailureReason(error) {
  return Object.hasOwn(OWNERSHIP_ERRORS, error?.code ?? '')
    ? OWNERSHIP_ERRORS[error.code] : OWNERSHIP_ERRORS.AGY_SESSION_STATE;
}

function classifyOwnershipError(error) {
  const code = error?.code === 'AGY_NATIVE_LOCK_FAILED' ? error?.cause?.code ?? error.code : error?.code;
  const category = Object.hasOwn(OWNERSHIP_ERRORS, code ?? '') ? code
    : code === 'AGY_NATIVE_LOCK_BUSY' ? 'AGY_SESSION_STATE_BUSY'
    : code === 'AGY_NATIVE_LOCK_LEGACY' ? 'AGY_SESSION_STATE_LEGACY_LOCK'
    : ['EACCES', 'EPERM', 'AGY_NATIVE_LOCK_PERMISSIONS'].includes(code) ? 'AGY_SESSION_STATE_PERMISSIONS'
    : code === 'AGY_NATIVE_LOCK_UNAVAILABLE' ? 'AGY_SESSION_STATE_NATIVE_UNAVAILABLE'
    : ['AGY_NATIVE_LOCK_SYMLINK', 'AGY_NATIVE_LOCK_INODE', 'AGY_NATIVE_LOCK_TYPE'].includes(code) ? 'AGY_SESSION_STATE_UNSAFE_LOCK'
    : 'AGY_SESSION_STATE';
  // No raw filesystem cause/path is carried into public RPC diagnostics.
  const message = category === 'AGY_SESSION_STATE_BUSY' ? 'agy session state is owned by another adapter'
    : category === 'AGY_SESSION_STATE_LEGACY_LOCK' ? 'agy legacy session state lock is unsupported'
    : category === 'AGY_SESSION_STATE' ? 'agy session state ownership could not be established'
    : OWNERSHIP_ERRORS[category];
  return stateError(message, category);
}

function validScope(scope) {
  return scope && typeof scope === 'object' && CHANNEL_RE.test(scope.channelId ?? '') &&
    OWNER_RE.test(scope.owner ?? '') && typeof scope.relay === 'string' && HASH_RE.test(scope.relay) &&
    typeof scope.cwd === 'string' && scope.cwd.length > 0 &&
    typeof scope.model === 'string' && scope.model.length > 0;
}

function scopeKey(channelId) {
  return createHash('sha256').update(channelId).digest('hex');
}

function normalizeRelay(value) {
  if (typeof value !== 'string' || !RELAY_RE.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (!url.hostname || url.username || url.password) return null;
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch { return null; }
}

function relayHash(value) {
  const canonical = normalizeRelay(value);
  return canonical ? createHash('sha256').update(canonical).digest('hex') : null;
}

function sameScope(left, right) {
  return ['owner', 'relay', 'cwd', 'model', 'channelId'].every((key) => left?.[key] === right?.[key]);
}

function sanitizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.schemaVersion !== 1 || record.sessionScope !== 'channel' ||
      !['ready', 'blocked'].includes(record.status) ||
      (record.status === 'ready' && !CONVERSATION_RE.test(record.conversationId ?? '')) ||
      (record.status === 'blocked' && record.conversationId !== null && !CONVERSATION_RE.test(record.conversationId ?? '')) ||
      !validScope(record.scope) || typeof record.updatedAt !== 'string') {
    throw stateError('agy session state is corrupted');
  }
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'conversationId,schemaVersion,scope,sessionScope,status,updatedAt') {
    throw stateError('agy session state is corrupted');
  }
  return record;
}

export function validateSessionRecord(record) {
  return sanitizeRecord(record);
}

export class SessionState {
  constructor({ dir, owner, relay, realpathFn = realpath, lockFn = acquireNativeLock, nowFn = () => new Date().toISOString() } = {}) {
    this.dir = typeof dir === 'string' && dir.trim() ? dir : null;
    this.owner = OWNER_RE.test(owner ?? '') ? owner.toLowerCase() : null;
    this.relay = relayHash(relay);
    this.realpathFn = realpathFn;
    this.lockFn = lockFn;
    this.nowFn = nowFn;
    this.configurationError = (this.dir || owner != null) &&
      (!this.dir || !this.owner || !this.relay)
      ? 'AGY_SESSION_DIR, AGY_SESSION_OWNER (64 hex characters), and AGY_RELAY_URL are all required'
      : null;
    this.ownedChannels = new Map();
  }

  get enabled() {
    return Boolean(this.dir && this.owner && this.relay && !this.configurationError);
  }

  async ensureOwnership(channelId = 'adapter') {
    if (!this.enabled) return false;
    if (!CHANNEL_RE.test(channelId) && channelId !== 'adapter') {
      throw stateError('agy session state scope is invalid', 'AGY_SESSION_STATE_SCOPE');
    }
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      const lockPath = join(this.dir, `.${scopeKey(channelId)}.lock`);
      if (this.ownedChannels.has(channelId)) return true;
      const lock = await this.lockFn(lockPath);
      this.ownedChannels.set(channelId, lock);
      return true;
    } catch (error) {
      throw classifyOwnershipError(error);
    }
  }

  ownsChannel(channelId) {
    return this.ownedChannels.has(channelId);
  }

  // Only the server's reserved, never-started preflight may release this lease.
  // Keep the map entry until release succeeds; never unlink a native lock file.
  async releaseOwnership(channelId) {
    const lock = this.ownedChannels.get(channelId);
    if (!lock) return false;
    await lock.release();
    this.ownedChannels.delete(channelId);
    return true;
  }

  async release() {
    let failure;
    for (const lock of this.ownedChannels.values()) {
      try { await lock.release(); }
      catch (error) { failure ??= error; }
    }
    this.ownedChannels.clear();
    if (failure) throw failure;
  }

  async scope({ channelId, cwd, model }) {
    if (!this.enabled) return null;
    if (!CHANNEL_RE.test(channelId ?? '') || typeof cwd !== 'string' || typeof model !== 'string' || !model) {
      throw stateError('agy session state scope is invalid');
    }
    let canonicalCwd;
    try { canonicalCwd = await this.realpathFn(cwd); }
    catch { throw stateError('agy session state cwd could not be canonicalized'); }
    const scope = { owner: this.owner, relay: this.relay, cwd: canonicalCwd, model, channelId };
    if (!validScope(scope)) throw stateError('agy session state scope is invalid');
    return scope;
  }

  path(channelId) {
    return join(this.dir, `${scopeKey(channelId)}.json`);
  }

  async verifyIdentity(identityFn) {
    if (!this.enabled) return true;
    if (typeof identityFn !== 'function') throw stateError('agy Buzz identity is unavailable');
    let identity;
    try { identity = await identityFn(); } catch { throw stateError('agy Buzz identity is unavailable'); }
    if (!OWNER_RE.test(identity ?? '') || identity.toLowerCase() !== this.owner) {
      throw stateError('agy Buzz identity does not match configured session owner', 'AGY_SESSION_OWNER_MISMATCH');
    }
    return true;
  }

  async load(scope) {
    if (!this.enabled) return null;
    if (!validScope(scope)) throw stateError('agy session state scope is invalid');
    await this.ensureOwnership(scope.channelId);
    let raw;
    try { raw = JSON.parse(await readFile(this.path(scope.channelId), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw stateError('agy session state is corrupted');
    }
    const record = sanitizeRecord(raw);
    if (!sameScope(record.scope, scope)) throw stateError('agy session state scope mismatch', 'AGY_SESSION_SCOPE_MISMATCH');
    if (record.status !== 'ready') throw stateError('agy session state is blocked after an incomplete turn', 'AGY_SESSION_STATE_BLOCKED');
    return record;
  }

  // Remember the completed, retired provider while the turn remains blocked.
  // This version-1 record remains compatible with existing readers. The server
  // must do this before publication; readiness still requires delivery success.
  async stageCheckpoint(scope, conversationId) {
    if (!this.enabled) return null;
    if (!validScope(scope) || !CONVERSATION_RE.test(conversationId ?? '')) {
      throw stateError('agy session state cannot stage an invalid association');
    }
    await this.ensureOwnership(scope.channelId);
    let current;
    try { current = sanitizeRecord(JSON.parse(await readFile(this.path(scope.channelId), 'utf8'))); }
    catch { throw stateError('agy session state cannot stage an unreadable association'); }
    if (!sameScope(current.scope, scope)) throw stateError('agy session state scope mismatch', 'AGY_SESSION_SCOPE_MISMATCH');
    if (current.status !== 'blocked') throw stateError('agy session state must be blocked before staging');
    const staged = { ...current, conversationId, status: 'blocked', updatedAt: this.nowFn() };
    const target = this.path(scope.channelId);
    const temp = join(this.dir, `.${scopeKey(scope.channelId)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(staged)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temp, target);
      await chmod(target, 0o600);
    } catch {
      await rm(temp, { force: true }).catch(() => {});
      throw stateError('agy session association could not be staged before publication');
    }
    return staged;
  }

  async save(scope, conversationId) {
    if (!this.enabled) return null;
    await this.ensureOwnership(scope.channelId);
    if (!validScope(scope) || !CONVERSATION_RE.test(conversationId ?? '')) {
      throw stateError('agy session state cannot save an invalid association');
    }
    const record = {
      schemaVersion: 1,
      sessionScope: 'channel',
      status: 'ready',
      scope: { ...scope },
      conversationId,
      updatedAt: this.nowFn()
    };
    const target = this.path(scope.channelId);
    const temp = join(this.dir, `.${scopeKey(scope.channelId)}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await rename(temp, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temp, { force: true });
      throw stateError('agy session state could not be saved');
    }
    return record;
  }

  // The cross-process guard is the ownership lock this instance already holds; the
  // caller adds the in-process one by refusing to reconcile while another turn of
  // this adapter is running on the channel. Under both, a record left `blocked` can
  // only come from a turn that is already dead, so the conversation is resumed and
  // the block is lifted. A record blocked before any conversation existed carries
  // nothing to resume and is removed, which starts the next turn fresh.
  async reconcile(scope) {
    if (!this.enabled) return { reconciled: false, conversationId: null };
    if (!validScope(scope)) throw stateError('agy session state scope is invalid');
    await this.ensureOwnership(scope.channelId);
    let raw;
    try { raw = JSON.parse(await readFile(this.path(scope.channelId), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return { reconciled: false, conversationId: null };
      throw stateError('agy session state is corrupted');
    }
    const current = sanitizeRecord(raw);
    if (!sameScope(current.scope, scope)) throw stateError('agy session state scope mismatch', 'AGY_SESSION_SCOPE_MISMATCH');
    if (current.status === 'ready') return { reconciled: false, conversationId: current.conversationId };
    if (!CONVERSATION_RE.test(current.conversationId ?? '')) {
      await rm(this.path(scope.channelId), { force: true });
      return { reconciled: true, conversationId: null };
    }
    const restored = await this.save(scope, current.conversationId);
    return { reconciled: true, conversationId: restored.conversationId };
  }

  async invalidate(scope) {
    if (!this.enabled) return false;
    await this.ensureOwnership(scope.channelId);
    let record;
    try { record = JSON.parse(await readFile(this.path(scope.channelId), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        const blocked = { schemaVersion: 1, sessionScope: 'channel', status: 'blocked',
          scope: { ...scope }, conversationId: null, updatedAt: this.nowFn() };
        const temp = join(this.dir, `.${scopeKey(scope.channelId)}.${randomUUID()}.tmp`);
        try {
          await writeFile(temp, `${JSON.stringify(blocked)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          await rename(temp, this.path(scope.channelId));
          await chmod(this.path(scope.channelId), 0o600);
          return true;
        } catch {
          await rm(temp, { force: true });
          throw stateError('agy session state could not be invalidated');
        }
      }
      throw stateError('agy session state is corrupted');
    }
    const current = sanitizeRecord(record);
    if (!sameScope(current.scope, scope)) throw stateError('agy session state scope mismatch', 'AGY_SESSION_SCOPE_MISMATCH');
    const blocked = { ...current, status: 'blocked', updatedAt: this.nowFn() };
    const temp = join(this.dir, `.${scopeKey(scope.channelId)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(blocked)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temp, this.path(scope.channelId));
      await chmod(this.path(scope.channelId), 0o600);
      return true;
    } catch {
      await rm(temp, { force: true });
      throw stateError('agy session state could not be invalidated');
    }
  }
}

export function createConfiguredSessionState(env = process.env) {
  const state = new SessionState({ dir: env.AGY_SESSION_DIR, owner: env.AGY_SESSION_OWNER,
    relay: env.BUZZ_RELAY_URL ?? env.AGY_RELAY_URL });
  if (env.AGY_SESSION_DIR && env.AGY_SESSION_OWNER && !env.BUZZ_RELAY_URL) {
    state.configurationError = 'BUZZ_RELAY_URL is required when durable session state is enabled';
  } else if (env.AGY_SESSION_DIR && env.AGY_SESSION_OWNER && env.AGY_RELAY_URL && env.BUZZ_RELAY_URL &&
      normalizeRelay(env.AGY_RELAY_URL) !== normalizeRelay(env.BUZZ_RELAY_URL)) {
    state.configurationError = 'AGY_RELAY_URL must match BUZZ_RELAY_URL when both are configured';
  }
  return state;
}
