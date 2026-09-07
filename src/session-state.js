import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OWNER_RE = /^[0-9a-f]{64}$/i;
const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RELAY_RE = /^(?:ws|wss|http|https):\/\/[^\s/]+(?:\/[^\s]*)?$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

function stateError(message, code = 'AGY_SESSION_STATE') {
  return Object.assign(new Error(message), { code, rpcMessage: message });
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

export class SessionState {
  constructor({ dir, owner, relay, realpathFn = realpath, nowFn = () => new Date().toISOString() } = {}) {
    this.dir = typeof dir === 'string' && dir.trim() ? dir : null;
    this.owner = OWNER_RE.test(owner ?? '') ? owner.toLowerCase() : null;
    this.relay = relayHash(relay);
    this.realpathFn = realpathFn;
    this.nowFn = nowFn;
    this.configurationError = (this.dir || owner != null) &&
      (!this.dir || !this.owner || !this.relay)
      ? 'AGY_SESSION_DIR, AGY_SESSION_OWNER (64 hex characters), and AGY_RELAY_URL are all required'
      : null;
    this.ownedChannels = new Set();
  }

  get enabled() {
    return Boolean(this.dir && this.owner && this.relay && !this.configurationError);
  }

  async ensureOwnership(channelId = 'adapter') {
    if (!this.enabled) return false;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    if (!CHANNEL_RE.test(channelId) && channelId !== 'adapter') throw stateError('agy session state scope is invalid');
    const lockPath = join(this.dir, `.${scopeKey(channelId)}.lock`);
    if (this.ownedChannels.has(channelId)) return true;
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      await writeFile(join(lockPath, 'owner'), `${process.pid}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      this.ownedChannels.add(channelId);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') throw stateError('agy session state is owned by another adapter', 'AGY_SESSION_STATE_BUSY');
      throw stateError('agy session state ownership could not be established');
    }
  }

  async release() {
    for (const channelId of this.ownedChannels) {
      await rm(join(this.dir, `.${scopeKey(channelId)}.lock`), { recursive: true, force: true });
    }
    this.ownedChannels.clear();
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
