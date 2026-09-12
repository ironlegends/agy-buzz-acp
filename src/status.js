import { access, lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateOutboxRecord } from './delivery/outbox.js';
import { validateSessionRecord } from './session-state.js';

export const MAX_STATE_ENTRIES = 1000;
export const MAX_STATE_FILE_BYTES = 256 * 1024;
const OUTBOX_FILENAME_RE = /^[A-Za-z0-9_-]{1,96}\.json$/;

function emptyRecords() {
  return { ready: 0, blocked: 0, uncertain: 0, invalid: 0 };
}

function emptyStatuses() {
  return { sent: 0, 'failed-before-start': 0, inflight: 0, uncertain: 0, invalid: 0 };
}

function addRecord(summary, kind, record) {
  const status = typeof record?.status === 'string' ? record.status : null;
  if (kind === 'session') {
    if (status === 'ready') summary.records.ready += 1;
    else if (status === 'blocked') summary.records.blocked += 1;
    else summary.records.invalid += 1;
    return;
  }
  if (status === 'sent' || status === 'failed-before-start') summary.records.ready += 1;
  else if (status === 'uncertain' || status === 'inflight') summary.records.uncertain += 1;
  else summary.records.invalid += 1;
  if (Object.hasOwn(summary.statuses, status)) summary.statuses[status] += 1;
  else summary.statuses.invalid += 1;
}

function lockResult() {
  return { total: 0, stale: 0, 'live-pid': 0, 'native-file': 0, unknown: 0, symlink: 0 };
}

function isLockName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.lock');
}

function isSafeEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

async function lockState(dir, name, { fsImpl, processAliveImpl }) {
  const result = { status: 'unknown' };
  try {
    const details = await fsImpl.lstat(join(dir, name));
    if (details?.isSymbolicLink?.()) return { status: 'symlink' };
    // A persistent native lock file is not evidence that its OS lock is held.
    // Offline diagnostics never acquire or release another session's lock.
    if (details?.isFile?.()) return { status: 'native-file' };
    if (details?.isDirectory?.() === false) return result;
    const ownerPath = join(dir, name, 'owner');
    let ownerText;
    try {
      const ownerDetails = await fsImpl.lstat(ownerPath);
      if (ownerDetails?.isSymbolicLink?.()) return { status: 'symlink' };
      ownerText = await fsImpl.readFile(ownerPath, 'utf8');
    } catch { ownerText = null; }
    const pid = /^\s*(\d+)\s*$/.exec(ownerText ?? '')?.[1];
    if (pid && typeof processAliveImpl === 'function') {
      let alive = null;
      try { alive = await processAliveImpl(Number(pid)); } catch { alive = null; }
      if (alive === false) return { status: 'stale' };
      if (alive === true) return { status: 'live-pid' };
    }
    return result;
  } catch {
    return result;
  }
}

/**
 * Inspect one configured state directory without invoking state-store methods.
 * This scanner only reads filenames, stat metadata and state records; it never
 * asks a store API to transition an inflight record.
 */
export async function inspectStateDirectory(dir, {
  kind = 'outbox',
  expectedOwner = null,
  fsImpl = { access, lstat, readdir, readFile, stat },
  processAliveImpl = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error?.code === 'ESRCH') return false;
      return null;
    }
  },
  maxEntries = MAX_STATE_ENTRIES,
  maxFileBytes = MAX_STATE_FILE_BYTES
} = {}) {
  const summary = {
    scan: { status: 'unknown', message: 'State contents could not be inspected safely' },
    records: emptyRecords(),
    locks: lockResult(),
    entries: { seen: 0, inspected: 0, truncated: false }
  };
  if (kind === 'outbox') summary.statuses = emptyStatuses();
  if (typeof dir !== 'string' || !dir.trim() || typeof fsImpl.lstat !== 'function' ||
      typeof fsImpl.readdir !== 'function' || typeof fsImpl.readFile !== 'function') {
    summary.scan.message = 'State contents are unavailable to this diagnostic';
    return summary;
  }
  try {
    const rootDetails = await fsImpl.lstat(dir);
    if (rootDetails?.isSymbolicLink?.()) {
      summary.scan.message = 'State directory is a symbolic link; contents were not inspected';
      summary.scan.status = 'warn';
      return summary;
    }
    if (rootDetails?.isDirectory?.() === false) {
      summary.scan.message = 'State path is not a directory';
      summary.scan.status = 'warn';
      return summary;
    }
  } catch {
    summary.scan.message = 'State directory could not be inspected';
    return summary;
  }
  let names;
  try { names = await fsImpl.readdir(dir); } catch {
    summary.scan.message = 'State contents could not be listed';
    return summary;
  }
  summary.entries.seen = names.length;
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_STATE_ENTRIES;
  const fileLimit = Number.isInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : MAX_STATE_FILE_BYTES;
  const inspectedNames = names.slice(0, limit);
  summary.entries.inspected = inspectedNames.length;
  summary.entries.truncated = names.length > inspectedNames.length;
  if (summary.entries.truncated) summary.scan.message = 'State contents were partially inspected within the entry limit';
  summary.scan.status = 'pass';
  if (!summary.entries.truncated) summary.scan.message = 'State contents were inspected without changing them';
  for (const name of inspectedNames) {
    if (!isSafeEntryName(name)) {
      summary.records.invalid += 1;
      if (kind === 'outbox') summary.statuses.invalid += 1;
      summary.scan.status = 'warn';
      continue;
    }
    if (isLockName(name)) {
      summary.locks.total += 1;
      const state = await lockState(dir, name, { fsImpl, processAliveImpl });
      summary.locks[state.status] += 1;
      if (state.status === 'symlink') summary.scan.status = 'warn';
      continue;
    }
    if (typeof name !== 'string' || !name.toLowerCase().endsWith('.json')) continue;
    try {
      if (kind === 'outbox' && !OUTBOX_FILENAME_RE.test(name)) throw new Error('invalid outbox filename');
      const recordPath = join(dir, name);
      const details = await fsImpl.lstat(recordPath);
      if (!details || details?.isSymbolicLink?.() || details?.isFile?.() !== true) throw new Error('unsafe record');
      if (!Number.isFinite(details?.size) || details.size < 0 || details.size > fileLimit) throw new Error('record is outside the read bound');
      const record = JSON.parse(await fsImpl.readFile(recordPath, 'utf8'));
      if (kind === 'session') validateSessionRecord(record);
      else {
        if (!OUTBOX_FILENAME_RE.test(name)) throw new Error('invalid outbox filename');
        if (!validateOutboxRecord(record) || record.recoveryId !== name.slice(0, -'.json'.length)) throw new Error('invalid outbox record binding');
        if (typeof expectedOwner === 'string' && record.owner.toLowerCase() !== expectedOwner.toLowerCase()) throw new Error('outbox owner mismatch');
      }
      addRecord(summary, kind, record);
    } catch {
      summary.records.invalid += 1;
      if (kind === 'outbox') summary.statuses.invalid += 1;
      summary.scan.status = 'warn';
    }
  }
  return summary;
}

export function stateSummaryStatus(summary) {
  if (summary?.scan?.status !== 'pass') return 'warn';
  if ((summary?.records?.blocked ?? 0) > 0 || (summary?.records?.uncertain ?? 0) > 0 ||
      (summary?.records?.invalid ?? 0) > 0 || (summary?.locks?.stale ?? 0) > 0 ||
      (summary?.locks?.symlink ?? 0) > 0 || summary?.entries?.truncated) return 'warn';
  return 'pass';
}
