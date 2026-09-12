import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { acquireNativeLock } from '../native-lock.js';

const OWNER_RE = /^[0-9a-f]{64}$/i;
const CHANNEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_RE = /^[0-9a-f]{64}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_STATUSES = new Set(['inflight', 'uncertain', 'failed-before-start', 'sent']);
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 1000;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
  return keys === 'channelId,content,createdAt,owner,recoveryId,replyTo,status,updatedAt' ||
    keys === 'channelId,content,createdAt,eventId,owner,recoveryId,replyTo,status,updatedAt';
}

export function validateOutboxRecord(record) {
  return validRecordShape(record);
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
  fsImpl = nativeOutboxReader,
  maxBytes = MAX_RECORD_BYTES
} = {}) {
  if (!validId(id)) return null;
  if (expectedOwner !== null && (typeof expectedOwner !== 'string' || !OWNER_RE.test(expectedOwner))) {
    throw outboxError('agy outbox expected owner is invalid', 'AGY_OUTBOX_OWNER_MISMATCH');
  }
  if (typeof fsImpl?.lstat !== 'function' || typeof fsImpl?.open !== 'function') {
    throw outboxError('agy outbox record reader is unavailable', 'AGY_OUTBOX_READER_UNAVAILABLE');
  }
  const limit = readableLimit(maxBytes);
  let details;
  try { details = await fsImpl.lstat(recordPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
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
  return record;
}

export class DeliveryOutbox {
  constructor({ dir, owner, idFn = randomUUID, nowFn = () => new Date().toISOString() } = {}) {
    this.dir = typeof dir === 'string' && dir.trim() ? dir : null;
    this.owner = typeof owner === 'string' && OWNER_RE.test(owner) ? owner.toLowerCase() : null;
    this.configurationError = (this.dir || owner != null) && (!this.dir || !this.owner)
      ? 'AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER (64 hex characters) are both required'
      : null;
    this.idFn = idFn;
    this.nowFn = nowFn;
  }

  get enabled() {
    return Boolean(this.dir && this.owner && !this.configurationError);
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

  async ensureDir() {
    if (!this.enabled) return false;
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
    if (!validId(id) || !validRecordShape(record) || record.recoveryId !== id || record.owner.toLowerCase() !== this.owner) {
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
    return this._withRecordLock(id, () => this._writeAtomic(id, record));
  }

  async _readRecord(id) {
    if (!this.enabled || !validId(id)) return null;
    if (!await this._inspectDirectory()) return null;
    return readOutboxRecordFile(this.path(id), id, { expectedOwner: this.owner });
  }

  async _withRecordLock(id, action) {
    await this.ensureDir();
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
    const recoveryId = this.idFn();
    const timestamp = this.nowFn();
    const record = { recoveryId, owner: this.owner, channelId, replyTo, content,
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

  async list() {
    if (!this.enabled) return [];
    if (!await this._inspectDirectory()) return [];
    let entries;
    try { entries = await readdir(this.dir, { withFileTypes: true }); }
    catch { throw outboxError('agy outbox directory could not be read', 'AGY_OUTBOX_READ'); }
    const recordEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.json')).sort((left, right) => left.name.localeCompare(right.name));
    if (recordEntries.length > MAX_RECORDS) throw outboxError('agy outbox contains too many records', 'AGY_OUTBOX_BOUNDS');
    const records = [];
    for (const entry of recordEntries) {
      const id = entry.name.slice(0, -'.json'.length);
      if (!validId(id) || entry.name !== `${id}.json`) {
        throw outboxError('agy outbox filename is invalid', 'AGY_OUTBOX_FILENAME');
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw outboxError('agy outbox record must be a regular file', 'AGY_OUTBOX_TYPE');
      }
      // Go through the public read path so a scan remains a pure read and keeps
      // the same validation contract as get/readRaw.
      const record = await this.readRaw(id);
      if (record) records.push(record);
    }
    return records;
  }

  async retry(id, { publish, owner } = {}) {
    if (!validId(id)) return { status: 'blocked', reason: 'invalid-id' };
    if (!this.enabled || typeof owner !== 'string' || owner.toLowerCase() !== this.owner) {
      return { status: 'blocked', reason: 'owner-mismatch' };
    }
    try {
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
  return new DeliveryOutbox({ dir: env.AGY_OUTBOX_DIR, owner: env.AGY_OUTBOX_OWNER });
}
