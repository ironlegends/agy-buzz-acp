import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { acquireNativeLock } from '../native-lock.js';

const OWNER_RE = /^[0-9a-f]{64}$/i;
const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_RE = /^[0-9a-f]{64}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RELAY_RE = /^(?:ws|wss|http|https):\/\/[^\s/]+(?:\/[^\s]*)?$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const RECORD_STATUSES = new Set(['inflight', 'uncertain', 'failed-before-start', 'sent']);
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_LIST_LIMIT = 1000;
export const OUTBOX_STORE_MARKER = '.agy-outbox-store';
const STORE_LOCK = '.agy-outbox-store.lock';

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function relayIdentity(value) {
  if (typeof value !== 'string' || !RELAY_RE.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (!url.hostname || url.username || url.password) return null;
    url.hash = '';
    const canonical = url.protocol + '//' + url.host + url.pathname.replace(/\/+$/, '') + url.search;
    return {
      canonical,
      fingerprint: createHash('sha256').update(canonical).digest('hex')
    };
  } catch {
    return null;
  }
}

export function outboxRelayFingerprint(value) {
  return relayIdentity(value)?.fingerprint ?? null;
}

function outboxError(message, code = 'AGY_OUTBOX') {
  return Object.assign(new Error(message), { code, rpcMessage: message });
}

function validRecordShape(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !validId(record.recoveryId) || !OWNER_RE.test(record.owner ?? '') ||
      !CHANNEL_RE.test(record.channelId ?? '') || !EVENT_RE.test(record.replyTo ?? '') ||
      typeof record.content !== 'string' || Buffer.byteLength(record.content, 'utf8') > MAX_RECORD_BYTES ||
      !RECORD_STATUSES.has(record.status) || !validDate(record.createdAt) ||
      !validDate(record.updatedAt) ||
      (record.eventId !== undefined && !EVENT_RE.test(record.eventId))) return false;
  if (record.status === 'sent' && !EVENT_RE.test(record.eventId ?? '')) return false;
  const keys = Object.keys(record).sort().join(',');
  const v1Keys = keys === 'channelId,content,createdAt,owner,recoveryId,replyTo,status,updatedAt' ||
    keys === 'channelId,content,createdAt,eventId,owner,recoveryId,replyTo,status,updatedAt';
  if (record.schemaVersion === undefined) return v1Keys;
  if (record.schemaVersion !== 2 || !HASH_RE.test(record.relayFingerprint ?? '')) return false;
  return keys === 'channelId,content,createdAt,owner,recoveryId,relayFingerprint,replyTo,schemaVersion,status,updatedAt' ||
    keys === 'channelId,content,createdAt,eventId,owner,recoveryId,relayFingerprint,replyTo,schemaVersion,status,updatedAt';
}

export function validateOutboxRecord(record) {
  return validRecordShape(record);
}

export function validateOutboxStoreMarker(marker, { owner = null, relayFingerprint = null } = {}) {
  const keys = marker && typeof marker === 'object' && !Array.isArray(marker)
    ? Object.keys(marker).sort().join(',')
    : '';
  if (keys !== 'owner,relayFingerprint,schemaVersion' || marker.schemaVersion !== 2 ||
      !OWNER_RE.test(marker.owner ?? '') || marker.owner !== marker.owner.toLowerCase() ||
      !HASH_RE.test(marker.relayFingerprint ?? '')) return false;
  if (owner !== null &&
      (typeof owner !== 'string' || !OWNER_RE.test(owner) || marker.owner !== owner.toLowerCase())) return false;
  if (relayFingerprint !== null &&
      (!HASH_RE.test(relayFingerprint) || marker.relayFingerprint !== relayFingerprint)) return false;
  return true;
}

function normalizeDeliveryResult(result) {
  if (result?.status === 'sent' && EVENT_RE.test(result.eventId ?? '')) {
    return { status: 'sent', eventId: result.eventId };
  }
  if (result?.status === 'failed-before-start') return { status: 'failed-before-start' };
  return { status: 'uncertain' };
}

const nativeOutboxReader = { lstat, open };

function readableLimit(maxBytes) {
  return Number.isInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_RECORD_BYTES)
    : MAX_RECORD_BYTES;
}

export async function readOutboxRecordFile(recordPath, id, {
  expectedOwner = null,
  expectedRelayFingerprint = null,
  fsImpl = nativeOutboxReader,
  maxBytes = MAX_RECORD_BYTES,
  requirePresent = false,
  returnBytes = false
} = {}) {
  if (!validId(id)) return null;
  if (expectedOwner !== null && (typeof expectedOwner !== 'string' || !OWNER_RE.test(expectedOwner))) {
    throw outboxError('agy outbox expected owner is invalid', 'AGY_OUTBOX_OWNER_MISMATCH');
  }
  if (expectedRelayFingerprint !== null && !HASH_RE.test(expectedRelayFingerprint)) {
    throw outboxError('agy outbox expected relay is invalid', 'AGY_OUTBOX_RELAY_MISMATCH');
  }
  if (typeof fsImpl?.lstat !== 'function' || typeof fsImpl?.open !== 'function') {
    throw outboxError('agy outbox record reader is unavailable', 'AGY_OUTBOX_READER_UNAVAILABLE');
  }
  const limit = readableLimit(maxBytes);
  let details;
  let rawBytes;
  let identity;
  try { details = await fsImpl.lstat(recordPath); }
  catch (error) {
    if (error?.code === 'ENOENT' && !requirePresent) return null;
    if (error?.code === 'ENOENT') throw outboxError('agy outbox record disappeared while scanning', 'AGY_OUTBOX_CHANGED');
    throw outboxError('agy outbox record could not be read', 'AGY_OUTBOX_READ');
  }
  if (details.isSymbolicLink()) throw outboxError('agy outbox record must not be a symlink', 'AGY_OUTBOX_SYMLINK');
  if (!details.isFile()) throw outboxError('agy outbox record is not a regular file', 'AGY_OUTBOX_TYPE');
  if (details.nlink !== 1) throw outboxError('agy outbox record must have one directory entry', 'AGY_OUTBOX_LINK');
  if (!Number.isFinite(details.size) || details.size < 0 || details.size > limit) {
    throw outboxError('agy outbox record exceeds the read limit', 'AGY_OUTBOX_BOUNDS');
  }

  // Bind the read to the descriptor opened for the file observed above. The
  // path is checked again after reading so replacement of the directory entry
  // is reported instead of returning an unbound snapshot.
  let handle;
  let operationError;
  let record;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    try { handle = await fsImpl.open(recordPath, flags); }
    catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error?.code)) {
        throw outboxError('agy outbox record changed while opening', 'AGY_OUTBOX_CHANGED');
      }
      throw error;
    }
    if (!handle || typeof handle.stat !== 'function' || typeof handle.read !== 'function' || typeof handle.close !== 'function') {
      throw outboxError('agy outbox record reader is unavailable', 'AGY_OUTBOX_READER_UNAVAILABLE');
    }
    const opened = await handle.stat();
    if (opened.isSymbolicLink()) throw outboxError('agy outbox record changed to a symlink', 'AGY_OUTBOX_CHANGED');
    if (!opened.isFile()) throw outboxError('agy outbox record changed to a non-file', 'AGY_OUTBOX_CHANGED');
    if (opened.nlink !== 1) throw outboxError('agy outbox record must have one directory entry', 'AGY_OUTBOX_LINK');
    if (!Number.isFinite(opened.size) || opened.size < 0 || opened.size > limit) {
      throw outboxError('agy outbox record exceeds the read limit', 'AGY_OUTBOX_BOUNDS');
    }
    if (opened.dev !== details.dev || opened.ino !== details.ino || opened.size !== details.size) {
      throw outboxError('agy outbox record changed while opening', 'AGY_OUTBOX_CHANGED');
    }

    const bytes = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) {
      throw outboxError('agy outbox record exceeds the read limit', 'AGY_OUTBOX_BOUNDS');
    }

    let after;
    try { after = await fsImpl.lstat(recordPath); }
    catch (error) {
      if (error?.code === 'ENOENT') throw outboxError('agy outbox record changed while reading', 'AGY_OUTBOX_CHANGED');
      throw error;
    }
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== details.dev || after.ino !== details.ino) {
      throw outboxError('agy outbox record changed while reading', 'AGY_OUTBOX_CHANGED');
    }
    if (after.nlink !== 1) throw outboxError('agy outbox record must have one directory entry', 'AGY_OUTBOX_LINK');
    if (!Number.isFinite(after.size) || after.size < 0 || after.size > limit) {
      throw outboxError('agy outbox record exceeds the read limit', 'AGY_OUTBOX_BOUNDS');
    }
    if (after.size !== details.size || after.size !== opened.size) {
      throw outboxError('agy outbox record changed while reading', 'AGY_OUTBOX_CHANGED');
    }

    rawBytes = Buffer.from(bytes.subarray(0, bytesRead));
    identity = { dev: details.dev, ino: details.ino, size: details.size };
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(0, bytesRead));
    } catch {
      throw outboxError('agy outbox record is unreadable', 'AGY_OUTBOX_CORRUPT');
    }
    try { record = JSON.parse(decoded); }
    catch { throw outboxError('agy outbox record is unreadable', 'AGY_OUTBOX_CORRUPT'); }
  } catch (error) {
    operationError = error;
    if (error?.code?.startsWith('AGY_OUTBOX_')) throw error;
    throw outboxError('agy outbox record is unreadable', 'AGY_OUTBOX_CORRUPT');
  } finally {
    try { await handle?.close(); }
    catch (error) {
      if (!operationError) throw outboxError('agy outbox record descriptor could not be closed', 'AGY_OUTBOX_READ');
    }
  }
  if (!validRecordShape(record)) throw outboxError('agy outbox record is invalid', 'AGY_OUTBOX_CORRUPT');
  if (record.recoveryId !== id) throw outboxError('agy outbox filename does not match its recovery id', 'AGY_OUTBOX_FILENAME');
  if (expectedOwner !== null && record.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw outboxError('agy outbox record owner does not match the configured owner', 'AGY_OUTBOX_OWNER_MISMATCH');
  }
  if (expectedRelayFingerprint !== null &&
      (record.schemaVersion !== 2 || record.relayFingerprint !== expectedRelayFingerprint)) {
    throw outboxError('agy outbox record relay does not match the configured relay', 'AGY_OUTBOX_RELAY_MISMATCH');
  }
  return returnBytes ? { record, bytes: rawBytes, identity } : record;
}

function pathContains(parent, child) {
  const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child;
  const relativePath = relative(normalizedParent, normalizedChild);
  return relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith('..' + sep));
}

async function inspectDirectoryPath(value) {
  const target = resolve(value);
  let targetDetails = null;
  let current = target;
  while (true) {
    let details;
    try { details = await lstat(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw outboxError('agy archive path could not be inspected', 'AGY_OUTBOX_ARCHIVE_PATH');
    }
    if (details) {
      if (details.isSymbolicLink()) throw outboxError('agy archive path must not contain symlinks', 'AGY_OUTBOX_ARCHIVE_PATH');
      if (!details.isDirectory()) throw outboxError('agy archive path ancestor is not a directory', 'AGY_OUTBOX_ARCHIVE_PATH');
      if (current === target) {
        targetDetails = details;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { target, details: targetDetails };
}

export class DeliveryOutbox {
  constructor({ dir, owner, relay, idFn = randomUUID, nowFn = () => new Date().toISOString() } = {}) {
    this.dir = typeof dir === 'string' && dir.trim() ? dir : null;
    this.owner = typeof owner === 'string' && OWNER_RE.test(owner) ? owner.toLowerCase() : null;
    this.relayFingerprint = relay == null ? null : outboxRelayFingerprint(relay);
    const configured = this.dir || owner != null || relay != null;
    this.configurationError = configured && (!this.dir || !this.owner)
      ? 'AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER (64 hex characters) are both required'
      : relay != null && !this.relayFingerprint
        ? 'BUZZ_RELAY_URL is invalid or contains unsupported credentials'
        : null;
    this.idFn = idFn;
    this.nowFn = nowFn;
  }

  get enabled() {
    return Boolean(this.dir && this.owner && !this.configurationError);
  }

  get writable() {
    return Boolean(this.enabled && this.relayFingerprint);
  }

  async _inspectDirectory() {
    let details = null;
    let current = this.dir;
    while (true) {
      let ancestor;
      try { ancestor = await lstat(current); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw outboxError('agy outbox directory could not be inspected', 'AGY_OUTBOX_DIRECTORY');
      }
      if (ancestor) {
        if (ancestor.isSymbolicLink()) throw outboxError('agy outbox directory must not be a symlink', 'AGY_OUTBOX_SYMLINK');
        if (!ancestor.isDirectory()) throw outboxError('agy outbox path is not a directory', 'AGY_OUTBOX_DIRECTORY');
        if (current === this.dir) details = ancestor;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return details;
  }

  async _readStoreMarker() {
    const markerPath = join(this.dir, OUTBOX_STORE_MARKER);
    let before;
    try { before = await lstat(markerPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw outboxError('agy outbox store marker could not be read', 'AGY_OUTBOX_STORE_MARKER');
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
        !Number.isFinite(before.size) || before.size < 1 || before.size > 4096) {
      throw outboxError('agy outbox store marker is unsafe or invalid', 'AGY_OUTBOX_STORE_MARKER');
    }

    let handle;
    let operationError;
    let marker;
    try {
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      handle = await open(markerPath, flags);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev ||
          opened.ino !== before.ino || opened.size !== before.size || opened.size > 4096) {
        throw outboxError('agy outbox store marker changed while opening', 'AGY_OUTBOX_STORE_MARKER');
      }
      const bytes = Buffer.alloc(4097);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count > 4096) throw outboxError('agy outbox store marker exceeds the read limit', 'AGY_OUTBOX_STORE_MARKER');
      const after = await lstat(markerPath);
      if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 ||
          after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
        throw outboxError('agy outbox store marker changed while reading', 'AGY_OUTBOX_STORE_MARKER');
      }
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)); }
      catch { throw outboxError('agy outbox store marker is corrupt', 'AGY_OUTBOX_STORE_MARKER'); }
      try { marker = JSON.parse(decoded); }
      catch { throw outboxError('agy outbox store marker is corrupt', 'AGY_OUTBOX_STORE_MARKER'); }
    } catch (error) {
      operationError = error;
      if (error?.code?.startsWith('AGY_OUTBOX_')) throw error;
      throw outboxError('agy outbox store marker could not be read', 'AGY_OUTBOX_STORE_MARKER');
    } finally {
      try { await handle?.close(); }
      catch (error) {
        if (!operationError) throw outboxError('agy outbox store marker descriptor could not be closed', 'AGY_OUTBOX_STORE_MARKER');
      }
    }
    if (!validateOutboxStoreMarker(marker)) {
      throw outboxError('agy outbox store marker is invalid', 'AGY_OUTBOX_STORE_MARKER');
    }
    if (!validateOutboxStoreMarker(marker, { owner: this.owner, relayFingerprint: this.relayFingerprint })) {
      throw outboxError('agy outbox store belongs to a different account or relay', 'AGY_OUTBOX_STORE_MISMATCH');
    }
    return marker;
  }

  async _storeMode() {
    if (!this.enabled) return 'disabled';
    if (!await this._inspectDirectory()) return 'missing';
    return await this._readStoreMarker() ? 'v2' : 'legacy';
  }

  async _ensureBoundStore() {
    if (!this.enabled) throw outboxError(this.configurationError ?? 'agy outbox is disabled', 'AGY_OUTBOX_CONFIG');
    if (!this.relayFingerprint) throw outboxError('agy legacy outbox is read-only', 'AGY_OUTBOX_READ_ONLY');
    await this.ensureDir();
    const lock = await acquireNativeLock(join(this.dir, STORE_LOCK));
    let actionError;
    try {
      const mode = await this._storeMode();
      if (mode === 'v2') return true;
      let directory;
      try { directory = await opendir(this.dir); }
      catch { throw outboxError('agy outbox directory could not be scanned for initialization', 'AGY_OUTBOX_DIRECTORY'); }
      for await (const entry of directory) {
        if (entry.name !== STORE_LOCK) {
          throw outboxError('agy unmarked legacy outbox is read-only and cannot be promoted', 'AGY_OUTBOX_LEGACY_READ_ONLY');
        }
      }
      const markerPath = join(this.dir, OUTBOX_STORE_MARKER);
      const handle = await open(markerPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          schemaVersion: 2,
          owner: this.owner,
          relayFingerprint: this.relayFingerprint
        }) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(markerPath, 0o600);
      return (await this._storeMode()) === 'v2';
    } catch (error) {
      actionError = error;
      throw error;
    } finally {
      try { await lock.release(); }
      catch (error) { if (!actionError) throw error; }
    }
  }

  async ensureDir() {
    if (!this.writable) return false;
    let details = await this._inspectDirectory();
    if (!details) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      details = await this._inspectDirectory();
      if (!details) throw outboxError('agy outbox directory could not be inspected', 'AGY_OUTBOX_DIRECTORY');
    }
    await chmod(this.dir, 0o700);
    return true;
  }

  path(id) {
    return join(this.dir, `${id}.json`);
  }

  lockPath(id) {
    return join(this.dir, `${id}.lock`);
  }

  async _writeAtomic(id, record) {
    if (!this.writable || !validId(id) || !validRecordShape(record) || record.schemaVersion !== 2 ||
        record.relayFingerprint !== this.relayFingerprint || record.recoveryId !== id ||
        record.owner.toLowerCase() !== this.owner) {
      throw outboxError('agy outbox record is invalid', 'AGY_OUTBOX_RECORD');
    }
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      throw outboxError('agy outbox record exceeds the read limit', 'AGY_OUTBOX_BOUNDS');
    }
    await this.ensureDir();
    const temp = join(this.dir, `.${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, this.path(id));
      await chmod(this.path(id), 0o600);
      return record;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  // Kept as a compatibility surface for callers that used the old helper. Store
  // transitions use _withRecordLock and never call this method from inside a lock.
  async writeAtomic(id, record) {
    if (!this.enabled || !validId(id)) return null;
    if (!this.writable) throw outboxError('agy legacy outbox is read-only', 'AGY_OUTBOX_READ_ONLY');
    if (!validRecordShape(record) || record.schemaVersion !== 2 ||
        record.relayFingerprint !== this.relayFingerprint || record.recoveryId !== id ||
        record.owner.toLowerCase() !== this.owner) {
      throw outboxError('agy outbox record is invalid', 'AGY_OUTBOX_RECORD');
    }
    return this._withRecordLock(id, async () => {
      const current = await this._readRecord(id);
      if (!current) {
        if (record.status !== 'inflight' || record.eventId !== undefined) {
          throw outboxError('agy outbox can only create an inflight record', 'AGY_OUTBOX_TRANSITION');
        }
        return this._writeAtomic(id, record);
      }
      for (const key of ['owner', 'channelId', 'replyTo', 'content', 'createdAt', 'schemaVersion', 'relayFingerprint']) {
        if (record[key] !== current[key]) {
          throw outboxError('agy outbox record identity cannot change', 'AGY_OUTBOX_TRANSITION');
        }
      }
      const changes = { status: record.status };
      if (record.eventId !== undefined) changes.eventId = record.eventId;
      return this._writeAtomic(id, this._nextRecord(current, changes));
    });
  }

  async _readRecordSnapshot(id, { requirePresent = false, mode = null } = {}) {
    if (!this.enabled || !validId(id)) return null;
    const storeMode = mode ?? await this._storeMode();
    if (storeMode === 'missing' || storeMode === 'disabled') return null;
    if (storeMode === 'v2' && !this.relayFingerprint) {
      throw outboxError('agy relay-bound outbox records require BUZZ_RELAY_URL', 'AGY_OUTBOX_RELAY_REQUIRED');
    }
    const snapshot = await readOutboxRecordFile(this.path(id), id, {
      expectedOwner: this.owner,
      expectedRelayFingerprint: storeMode === 'v2' ? this.relayFingerprint : null,
      requirePresent,
      returnBytes: true
    });
    if (!snapshot) return null;
    if (storeMode === 'legacy' && snapshot.record.schemaVersion !== undefined) {
      throw outboxError('agy schema-v2 outbox records require a bound store marker', 'AGY_OUTBOX_STORE_MARKER');
    }
    if (storeMode === 'v2' && snapshot.record.schemaVersion !== 2) {
      throw outboxError('agy schema-v2 outbox store contains a legacy record', 'AGY_OUTBOX_STORE_MARKER');
    }
    return snapshot;
  }

  async _readRecord(id, options = {}) {
    const snapshot = await this._readRecordSnapshot(id, options);
    return snapshot?.record ?? null;
  }

  async _withRecordLock(id, action) {
    if (!this.writable) throw outboxError('agy legacy outbox is read-only', 'AGY_OUTBOX_READ_ONLY');
    await this._ensureBoundStore();
    let lock;
    try { lock = await acquireNativeLock(this.lockPath(id)); }
    catch (error) { throw error; }
    let actionError;
    try {
      return await action();
    } catch (error) {
      actionError = error;
      throw error;
    } finally {
      try { await lock.release(); }
      catch (error) { if (!actionError) throw error; }
    }
  }

  async _withArchiveRecordLock(id, action) {
    if (!this.writable) throw outboxError('agy archive requires a configured relay', 'AGY_OUTBOX_RELAY_REQUIRED');
    if (!await this._inspectDirectory()) throw outboxError('agy outbox directory is unavailable', 'AGY_OUTBOX_DIRECTORY');
    let lock;
    try { lock = await acquireNativeLock(this.lockPath(id)); }
    catch (error) { throw error; }
    let actionError;
    try {
      return await action();
    } catch (error) {
      actionError = error;
      throw error;
    } finally {
      try { await lock.release(); }
      catch (error) { if (!actionError) throw error; }
    }
  }

  async begin({ channelId, replyTo, content } = {}) {
    if (!this.enabled) return null;
    if (!this.writable) throw outboxError('agy legacy outbox is read-only', 'AGY_OUTBOX_READ_ONLY');
    const recoveryId = this.idFn();
    const timestamp = this.nowFn();
    const record = { schemaVersion: 2, relayFingerprint: this.relayFingerprint,
      recoveryId, owner: this.owner, channelId, replyTo, content,
      status: 'inflight', createdAt: timestamp, updatedAt: timestamp };
    if (!validRecordShape(record)) throw outboxError('agy outbox record is invalid', 'AGY_OUTBOX_RECORD');
    return this._withRecordLock(recoveryId, async () => {
      const existing = await this._readRecord(recoveryId);
      if (existing) throw outboxError('agy outbox recovery id already exists', 'AGY_OUTBOX_COLLISION');
      await this._writeAtomic(recoveryId, record);
      return recoveryId;
    });
  }

  async readRaw(id) {
    return this._readRecord(id);
  }

  async get(id) {
    return this.readRaw(id);
  }

  _nextRecord(record, changes, { retryFinal = false } = {}) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw outboxError('agy outbox transition is invalid', 'AGY_OUTBOX_TRANSITION');
    }
    const keys = Object.keys(changes);
    if (keys.some((key) => !['status', 'eventId'].includes(key))) {
      throw outboxError('agy outbox transition contains unsupported fields', 'AGY_OUTBOX_TRANSITION');
    }
    const nextStatus = Object.hasOwn(changes, 'status') ? changes.status : record.status;
    const transitions = {
      inflight: new Set(['inflight', 'failed-before-start', 'uncertain', 'sent']),
      'failed-before-start': new Set(['failed-before-start', 'uncertain', 'sent']),
      uncertain: new Set(retryFinal ? ['uncertain', 'failed-before-start', 'sent'] : ['uncertain']),
      sent: new Set(['sent'])
    };
    if (!transitions[record.status]?.has(nextStatus)) {
      throw outboxError('agy outbox status transition is not permitted', 'AGY_OUTBOX_TRANSITION');
    }
    let eventId = Object.hasOwn(changes, 'eventId') ? changes.eventId : record.eventId;
    if (eventId !== undefined && !EVENT_RE.test(eventId)) {
      throw outboxError('agy outbox acknowledgement is invalid', 'AGY_OUTBOX_ACK');
    }
    if (nextStatus === 'sent' && !EVENT_RE.test(eventId ?? '')) {
      throw outboxError('agy sent outbox records require an acknowledgement', 'AGY_OUTBOX_ACK');
    }
    if (record.status === 'sent' && (!eventId || eventId.toLowerCase() !== record.eventId.toLowerCase())) {
      throw outboxError('agy sent outbox acknowledgement cannot change', 'AGY_OUTBOX_TRANSITION');
    }
    const next = { ...record, status: nextStatus, updatedAt: this.nowFn() };
    if (eventId !== undefined) next.eventId = eventId;
    else delete next.eventId;
    if (!validRecordShape(next)) throw outboxError('agy outbox transition produced an invalid record', 'AGY_OUTBOX_RECORD');
    return next;
  }

  async update(id, changes = {}) {
    if (!this.enabled || !validId(id)) return null;
    return this._withRecordLock(id, async () => {
      const record = await this._readRecord(id);
      if (!record) return null;
      const next = this._nextRecord(record, changes);
      return this._writeAtomic(id, next);
    });
  }

  async _forEachRecord(visitor) {
    if (!this.enabled) return;
    const mode = await this._storeMode();
    if (mode === 'missing' || mode === 'disabled') return;
    let directory;
    try { directory = await opendir(this.dir); }
    catch { throw outboxError('agy outbox directory could not be read', 'AGY_OUTBOX_READ'); }
    try {
      for await (const entry of directory) {
        if (!entry.name.toLowerCase().endsWith('.json')) continue;
        const id = entry.name.slice(0, -'.json'.length);
        if (!validId(id) || entry.name !== `${id}.json`) {
          throw outboxError('agy outbox filename is invalid', 'AGY_OUTBOX_FILENAME');
        }
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw outboxError('agy outbox record must be a regular file', 'AGY_OUTBOX_TYPE');
        }
        const record = await this._readRecord(id, { requirePresent: true, mode });
        if (!record) throw outboxError('agy outbox record disappeared while scanning', 'AGY_OUTBOX_CHANGED');
        await visitor(record);
      }
    } catch (error) {
      if (error?.code?.startsWith('AGY_OUTBOX_') || error?.code?.startsWith('AGY_NATIVE_LOCK_')) throw error;
      throw outboxError('agy outbox directory could not be read', 'AGY_OUTBOX_READ');
    }
  }

  async hasUnsettledDelivery(channelId) {
    if (!this.enabled) return false;
    if (!CHANNEL_RE.test(channelId ?? '')) {
      throw outboxError('agy outbox channel is invalid', 'AGY_OUTBOX_CHANNEL');
    }
    let unsettled = false;
    await this._forEachRecord(async (record) => {
      if (record.channelId.toLowerCase() === channelId.toLowerCase() && record.status !== 'sent') {
        unsettled = true;
      }
    });
    return unsettled;
  }

  async listPage({ after = null, limit = 100 } = {}) {
    if (!this.enabled) return { records: [], nextCursor: null };
    if ((after !== null && !validId(after)) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw outboxError('agy outbox page cursor or limit is invalid', 'AGY_OUTBOX_BOUNDS');
    }
    const retained = [];
    await this._forEachRecord(async (record) => {
      if (after !== null && record.recoveryId <= after) return;
      let index = 0;
      while (index < retained.length && retained[index].recoveryId < record.recoveryId) index += 1;
      retained.splice(index, 0, record);
      if (retained.length > limit + 1) retained.pop();
    });
    const hasMore = retained.length > limit;
    return {
      records: retained.slice(0, limit),
      nextCursor: hasMore ? retained[limit - 1].recoveryId : null
    };
  }

  async list() {
    const page = await this.listPage({ limit: MAX_LIST_LIMIT });
    if (page.nextCursor) throw outboxError('agy outbox contains too many records for list()', 'AGY_OUTBOX_BOUNDS');
    return page.records;
  }

  async _prepareArchiveDirectory(archiveDir, dryRun) {
    if (typeof archiveDir !== 'string' || !archiveDir.trim()) {
      throw outboxError('agy archive destination is required', 'AGY_OUTBOX_ARCHIVE_PATH');
    }
    const outboxPath = resolve(this.dir);
    const inspected = await inspectDirectoryPath(archiveDir);
    const target = inspected.target;
    if (pathContains(outboxPath, target) || pathContains(target, outboxPath)) {
      throw outboxError('agy archive destination must be separate from the outbox', 'AGY_OUTBOX_ARCHIVE_PATH');
    }
    if (inspected.details) {
      if (process.platform !== 'win32' && (inspected.details.mode & 0o077) !== 0) {
        throw outboxError('agy archive directory permissions are unsafe', 'AGY_OUTBOX_ARCHIVE_PATH');
      }
      return target;
    }
    if (dryRun) return target;
    try { await mkdir(target, { recursive: true, mode: 0o700 }); }
    catch { throw outboxError('agy archive directory could not be created', 'AGY_OUTBOX_ARCHIVE_PATH'); }
    const created = await inspectDirectoryPath(target);
    if (!created.details) throw outboxError('agy archive directory could not be inspected', 'AGY_OUTBOX_ARCHIVE_PATH');
    await chmod(target, 0o700);
    return target;
  }

  async _assertArchiveTargetAbsent(archiveDir, id) {
    const targetPath = join(archiveDir, id + '.json');
    try {
      const details = await lstat(targetPath);
      if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
        throw outboxError('agy archive destination entry is unsafe', 'AGY_OUTBOX_ARCHIVE_PATH');
      }
      throw outboxError('agy archive destination already exists', 'AGY_OUTBOX_ARCHIVE_EXISTS');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code?.startsWith('AGY_OUTBOX_')) throw error;
      throw outboxError('agy archive destination could not be inspected', 'AGY_OUTBOX_ARCHIVE_PATH');
    }
  }

  async _archiveSentRecord(id, archiveDir) {
    return this._withArchiveRecordLock(id, async () => {
      const source = await this._readRecordSnapshot(id, { requirePresent: true });
      if (!source) throw outboxError('agy outbox record disappeared while archiving', 'AGY_OUTBOX_CHANGED');
      if (source.record.status !== 'sent') return false;

      await this._assertArchiveTargetAbsent(archiveDir, id);
      const destinationPath = join(archiveDir, id + '.json');
      const pathState = await inspectDirectoryPath(archiveDir);
      if (!pathState.details) throw outboxError('agy archive directory disappeared', 'AGY_OUTBOX_ARCHIVE_PATH');

      let destination;
      let destinationIdentity = null;
      let verified = false;
      try {
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0);
        try { destination = await open(destinationPath, flags, 0o600); }
        catch (error) {
          if (error?.code === 'EEXIST') {
            throw outboxError('agy archive destination already exists', 'AGY_OUTBOX_ARCHIVE_EXISTS');
          }
          throw error;
        }
        const created = await destination.stat();
        if (!created.isFile() || created.nlink !== 1) {
          throw outboxError('agy archive destination is unsafe', 'AGY_OUTBOX_ARCHIVE_PATH');
        }
        destinationIdentity = { dev: created.dev, ino: created.ino };
        await destination.writeFile(source.bytes);
        await destination.sync();
        await destination.close();
        destination = null;

        let copied;
        try {
          copied = await readOutboxRecordFile(destinationPath, id, {
            expectedOwner: this.owner,
            returnBytes: true
          });
        } catch {
          throw outboxError('agy archive copy could not be verified', 'AGY_OUTBOX_ARCHIVE_VERIFY');
        }
        if (!copied || !copied.bytes.equals(source.bytes)) {
          throw outboxError('agy archive copy does not match the source bytes', 'AGY_OUTBOX_ARCHIVE_VERIFY');
        }
        verified = true;

        const sourceAgain = await this._readRecordSnapshot(id, { requirePresent: true });
        if (!sourceAgain || sourceAgain.record.status !== 'sent' ||
            sourceAgain.identity.dev !== source.identity.dev ||
            sourceAgain.identity.ino !== source.identity.ino ||
            !sourceAgain.bytes.equals(source.bytes)) {
          throw outboxError('agy outbox source changed while archiving', 'AGY_OUTBOX_CHANGED');
        }
        const currentSource = await lstat(this.path(id));
        if (currentSource.isSymbolicLink() || !currentSource.isFile() || currentSource.nlink !== 1 ||
            currentSource.dev !== source.identity.dev || currentSource.ino !== source.identity.ino) {
          throw outboxError('agy outbox source changed before archival removal', 'AGY_OUTBOX_CHANGED');
        }
        await unlink(this.path(id));
        return true;
      } catch (error) {
        await destination?.close().catch(() => {});
        if (destinationIdentity && !verified) {
          try {
            const current = await lstat(destinationPath);
            if (!current.isSymbolicLink() && current.isFile() && current.nlink === 1 &&
                current.dev === destinationIdentity.dev && current.ino === destinationIdentity.ino) {
              await unlink(destinationPath);
            }
          } catch {}
        }
        if (error?.code?.startsWith('AGY_OUTBOX_')) throw error;
        throw outboxError('agy outbox record could not be archived safely', 'AGY_OUTBOX_ARCHIVE');
      }
    });
  }

  async archiveSent({ archiveDir, dryRun = true } = {}) {
    if (!this.enabled) throw outboxError('agy outbox is disabled', 'AGY_OUTBOX_CONFIG');
    if (!this.writable) throw outboxError('agy archive requires a configured relay', 'AGY_OUTBOX_RELAY_REQUIRED');
    if (typeof dryRun !== 'boolean') throw outboxError('agy archive mode is invalid', 'AGY_OUTBOX_ARCHIVE_MODE');
    await this._storeMode();
    const destination = await this._prepareArchiveDirectory(archiveDir, dryRun);
    let eligible = 0;
    let archived = 0;
    let skipped = 0;
    await this._forEachRecord(async (record) => {
      if (record.status !== 'sent') {
        skipped += 1;
        return;
      }
      eligible += 1;
      if (dryRun) {
        await this._assertArchiveTargetAbsent(destination, record.recoveryId);
        return;
      }
      if (await this._archiveSentRecord(record.recoveryId, destination)) archived += 1;
      else {
        eligible -= 1;
        skipped += 1;
      }
    });
    return { mode: dryRun ? 'dry-run' : 'apply', eligible, archived, skipped };
  }

  async retry(id, { publish, owner } = {}) {
    if (!validId(id)) return { status: 'blocked', reason: 'invalid-id' };
    if (!this.enabled || typeof owner !== 'string' || owner.toLowerCase() !== this.owner) {
      return { status: 'blocked', reason: 'owner-mismatch' };
    }
    if (!this.writable) return { status: 'blocked', reason: 'relay-required' };
    try {
      if (await this._storeMode() === 'legacy') {
        const legacyRecord = await this._readRecord(id);
        return { status: 'blocked', reason: legacyRecord ? 'legacy-unbound' : 'missing' };
      }
      return await this._withRecordLock(id, async () => {
        let record;
        try { record = await this._readRecord(id); }
        catch (error) {
          if (error?.code === 'AGY_OUTBOX_OWNER_MISMATCH') return { status: 'blocked', reason: 'owner-mismatch' };
          return { status: 'blocked', reason: 'invalid-record' };
        }
        if (!record) return { status: 'blocked', reason: 'missing' };
        if (record.owner.toLowerCase() !== this.owner) return { status: 'blocked', reason: 'owner-mismatch' };
        if (record.status !== 'failed-before-start') return { status: 'blocked', reason: record.status };
        if (typeof publish !== 'function') return { status: 'blocked', reason: 'publisher-unavailable' };

        let claimed;
        try {
          claimed = this._nextRecord(record, { status: 'uncertain' });
          await this._writeAtomic(id, claimed);
        } catch {
          return { status: 'blocked', reason: 'durability-failure' };
        }

        let result;
        try { result = await publish({ channelId: claimed.channelId, replyTo: claimed.replyTo, content: claimed.content }); }
        catch { result = { status: 'uncertain' }; }
        const outcome = normalizeDeliveryResult(result);
        try {
          const final = this._nextRecord(claimed, outcome, { retryFinal: true });
          await this._writeAtomic(id, final);
          return outcome;
        } catch {
          // The external effect is now ambiguous if its positive acknowledgement
          // could not be persisted. Keep the durable claim and fail closed.
          return { status: 'uncertain' };
        }
      });
    } catch (error) {
      if (error?.code === 'AGY_OUTBOX_LEGACY_READ_ONLY') {
        return { status: 'blocked', reason: 'legacy-unbound' };
      }
      if (error?.code === 'AGY_OUTBOX_STORE_MISMATCH' || error?.code === 'AGY_OUTBOX_RELAY_MISMATCH') {
        return { status: 'blocked', reason: 'store-mismatch' };
      }
      if (['AGY_NATIVE_LOCK_BUSY', 'AGY_NATIVE_LOCK_LEGACY'].includes(error?.code)) {
        return { status: 'blocked', reason: 'busy' };
      }
      if (error?.code?.startsWith('AGY_NATIVE_LOCK_')) {
        return { status: 'blocked', reason: 'lock-unavailable' };
      }
      throw error;
    }
  }
}

export function createConfiguredOutbox(env = process.env) {
  const configured = Boolean(env.AGY_OUTBOX_DIR || env.AGY_OUTBOX_OWNER);
  const outbox = new DeliveryOutbox({
    dir: env.AGY_OUTBOX_DIR,
    owner: env.AGY_OUTBOX_OWNER,
    relay: configured ? env.BUZZ_RELAY_URL : undefined
  });
  if (configured && !env.BUZZ_RELAY_URL && !outbox.configurationError) {
    outbox.configurationError = 'BUZZ_RELAY_URL is required when durable outbox storage is enabled';
  }
  return outbox;
}
