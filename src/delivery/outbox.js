import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OWNER_RE = /^[0-9a-f]{64}$/i;

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(id);
}

export class DeliveryOutbox {
  constructor({ dir, owner, idFn = randomUUID, nowFn = () => new Date().toISOString() } = {}) {
    this.dir = typeof dir === 'string' && dir.trim() ? dir : null;
    this.owner = OWNER_RE.test(owner ?? '') ? owner.toLowerCase() : null;
    this.configurationError = (this.dir || owner != null) && (!this.dir || !this.owner)
      ? 'AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER (64 hex characters) are both required'
      : null;
    this.idFn = idFn;
    this.nowFn = nowFn;
  }

  get enabled() {
    return Boolean(this.dir && this.owner && !this.configurationError);
  }

  async ensureDir() {
    if (!this.enabled) return false;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    return true;
  }

  path(id) {
    return join(this.dir, `${id}.json`);
  }

  async writeAtomic(id, record) {
    if (!this.enabled || !validId(id)) return null;
    await this.ensureDir();
    const temp = join(this.dir, `.${id}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, this.path(id));
    await chmod(this.path(id), 0o600);
    return record;
  }

  async begin({ channelId, replyTo, content }) {
    if (!this.enabled) return null;
    const recoveryId = this.idFn();
    const timestamp = this.nowFn();
    const record = { recoveryId, owner: this.owner, channelId, replyTo, content, status: 'inflight', createdAt: timestamp, updatedAt: timestamp };
    return (await this.writeAtomic(recoveryId, record)) && recoveryId;
  }

  async readRaw(id) {
    if (!this.enabled || !validId(id)) return null;
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async get(id) {
    const record = await this.readRaw(id);
    if (!record) return null;
    if (record.status === 'inflight') {
      record.status = 'uncertain';
      record.updatedAt = this.nowFn();
      await this.writeAtomic(id, record);
    }
    return record;
  }

  async update(id, changes) {
    const record = await this.readRaw(id);
    if (!record) return null;
    const next = { ...record, ...changes, updatedAt: this.nowFn() };
    return this.writeAtomic(id, next);
  }

  async list() {
    if (!this.enabled) return [];
    await this.ensureDir();
    const names = await readdir(this.dir);
    const records = [];
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      const record = await this.get(name.slice(0, -5));
      if (record) records.push(record);
    }
    return records;
  }

  async retry(id, { publish, owner } = {}) {
    if (!validId(id)) return { status: 'blocked', reason: 'invalid-id' };
    if (!this.enabled || typeof owner !== 'string' || owner.toLowerCase() !== this.owner) return { status: 'blocked', reason: 'owner-mismatch' };
    const lock = join(this.dir, `${id}.lock`);
    try {
      await mkdir(lock, { recursive: false });
    } catch (error) {
      if (error?.code === 'EEXIST') return { status: 'blocked', reason: 'busy' };
      throw error;
    }
    try {
      const record = await this.get(id);
      if (!record) return { status: 'blocked', reason: 'missing' };
      if (record.owner !== this.owner) return { status: 'blocked', reason: 'owner-mismatch' };
      if (record.status !== 'failed-before-start') return { status: 'blocked', reason: record.status };
      if (typeof publish !== 'function') return { status: 'blocked', reason: 'publisher-unavailable' };
      // A crash after this durable transition is ambiguous and therefore never
      // silently retried by a later process.
      await this.update(id, { status: 'uncertain' });
      let result;
      try { result = await publish({ channelId: record.channelId, replyTo: record.replyTo, content: record.content }); }
      catch { result = { status: 'uncertain' }; }
      const status = result?.status === 'sent' ? 'sent' : result?.status === 'failed-before-start' ? 'failed-before-start' : 'uncertain';
      await this.update(id, { status, ...(result?.eventId ? { eventId: result.eventId } : {}) });
      return { status, ...(result?.eventId ? { eventId: result.eventId } : {}) };
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

export function createConfiguredOutbox(env = process.env) {
  return new DeliveryOutbox({ dir: env.AGY_OUTBOX_DIR, owner: env.AGY_OUTBOX_OWNER });
}
