import { createHash, randomUUID } from 'node:crypto';
import { constants, fstat } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { acquireNativeLock } from './native-lock.js';
import { SessionState, validateSessionRecord } from './session-state.js';
import {
  acquireSessionStateStoreInitializationLock,
  assertSafeSessionStatePath,
  canonicalChannelId,
  createSessionStateStoreMarker,
  readSessionStateFile,
  sessionStateChannelHash,
  sessionStateStoreMarkerPath,
  SESSION_STATE_STORE_MARKER,
  validateSessionStateStoreMarker
} from './session-state-store.js';

const fstatAsync = promisify(fstat);
const RECORD_NAME = /^([0-9a-f]{64})\.json$/;
const LOCK_NAME = /^\.([0-9a-f]{64})\.lock$/;
const MAX_RECORD_BYTES = 64 * 1024;

function migrationError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function legacyChannelHash(channelId) {
  return createHash('sha256').update(channelId).digest('hex');
}

function within(root, candidate) {
  const rootIdentity = process.platform === 'win32' ? root.toLowerCase() : root;
  const candidateIdentity = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const pathFromRoot = relative(rootIdentity, candidateIdentity);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

async function checkPath(path) {
  try { await assertSafeSessionStatePath(path); }
  catch (error) { throw migrationError('migration paths and their ancestors must not contain links', 'AGY_STATE_MIGRATION_UNSAFE_PATH', error); }
}

async function assertPrivateDirectory(path, code) {
  const stat = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') throw migrationError('migration source or destination parent is unavailable', code, error);
    throw migrationError('migration directory could not be inspected safely', code, error);
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw migrationError('migration directory is unsafe or not private', code);
  }
  return stat;
}

function fileSignature(stat) {
  return [stat.dev, stat.ino, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

async function scanLegacyStore(sourceDir, expectedOwner, expectedRelay) {
  const names = (await readdir(sourceDir)).sort();
  if (names.includes(SESSION_STATE_STORE_MARKER)) {
    throw migrationError('the source store is already marked; migration accepts only unmarked legacy stores',
      'AGY_STATE_MIGRATION_MARKED_SOURCE');
  }
  const recordsByHash = new Map();
  const lockFiles = new Map();
  const files = new Map();

  for (const name of names) {
    const recordMatch = RECORD_NAME.exec(name);
    const lockMatch = LOCK_NAME.exec(name);
    if (!recordMatch && !lockMatch) {
      throw migrationError('the legacy store contains an unknown file', 'AGY_STATE_MIGRATION_UNKNOWN_FILE');
    }
    const path = join(sourceDir, name);
    let stat;
    try { stat = await lstat(path, { bigint: true }); }
    catch (error) { throw migrationError('a legacy store entry could not be inspected safely', 'AGY_STATE_MIGRATION_UNSAFE_FILE', error); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
        (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n)) {
      throw migrationError('a legacy store entry is linked, nonregular, or insufficiently private', 'AGY_STATE_MIGRATION_UNSAFE_FILE');
    }
    files.set(name, { signature: fileSignature(stat), text: null });
    if (lockMatch) {
      if (stat.size !== 0n) throw migrationError('a legacy channel lock contains unexpected data', 'AGY_STATE_MIGRATION_UNSAFE_FILE');
      lockFiles.set(lockMatch[1], path);
      continue;
    }

    let file;
    try { file = await readSessionStateFile(path, MAX_RECORD_BYTES); }
    catch (error) { throw migrationError('a legacy session record is unsafe or unreadable', 'AGY_STATE_MIGRATION_UNSAFE_FILE', error); }
    let record;
    try { record = JSON.parse(file.text); validateSessionRecord(record); }
    catch (error) { throw migrationError('a legacy session record is invalid', 'AGY_STATE_MIGRATION_INVALID_RECORD', error); }
    if (file.text !== `${JSON.stringify(record)}\n`) {
      throw migrationError('a legacy session record is not in the supported canonical v1 encoding', 'AGY_STATE_MIGRATION_INVALID_RECORD');
    }
    const rawChannelId = record.scope.channelId;
    const canonicalId = canonicalChannelId(rawChannelId);
    if (!canonicalId || legacyChannelHash(rawChannelId) !== recordMatch[1] ||
        record.scope.owner.toLowerCase() !== expectedOwner || record.scope.relay !== expectedRelay) {
      throw migrationError('a legacy session record does not match its filename or configured store binding',
        'AGY_STATE_MIGRATION_INVALID_RECORD');
    }
    const targetHash = sessionStateChannelHash(canonicalId);
    if (recordsByHash.has(targetHash)) {
      throw migrationError('multiple legacy channel records collapse to one canonical UUID', 'AGY_STATE_MIGRATION_COLLISION');
    }
    const normalized = {
      ...record,
      scope: { ...record.scope, owner: expectedOwner, channelId: canonicalId }
    };
    recordsByHash.set(targetHash, {
      sourceHash: recordMatch[1],
      sourceName: name,
      destinationName: `${targetHash}.json`,
      text: `${JSON.stringify(normalized)}\n`,
      record: normalized
    });
    files.get(name).text = file.text;
  }

  if (recordsByHash.size === 0) {
    throw migrationError('the legacy store contains no session records to migrate', 'AGY_STATE_MIGRATION_EMPTY_SOURCE');
  }
  const recordHashes = new Set([...recordsByHash.values()].map((record) => record.sourceHash));
  for (const hash of lockFiles.keys()) {
    if (!recordHashes.has(hash)) {
      throw migrationError('the legacy store contains an opaque lock without an associated record', 'AGY_STATE_MIGRATION_OPAQUE_LOCK');
    }
  }
  for (const hash of recordHashes) {
    if (!lockFiles.has(hash)) {
      throw migrationError('a legacy session record has no associated native channel lock', 'AGY_STATE_MIGRATION_MISSING_LOCK');
    }
  }
  return { names, files, lockFiles, records: [...recordsByHash.values()].sort((a, b) => a.sourceName.localeCompare(b.sourceName)) };
}

function sameScan(left, right) {
  if (left.names.length !== right.names.length || left.names.some((name, index) => name !== right.names[index])) return false;
  for (const name of left.names) {
    const a = left.files.get(name);
    const b = right.files.get(name);
    if (!a || !b || a.signature !== b.signature || a.text !== b.text) return false;
  }
  return true;
}

async function acquireSourceLocks(scan) {
  const locks = [];
  try {
    for (const [, path] of [...scan.lockFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let lock;
      try { lock = await acquireNativeLock(path); }
      catch (error) {
        if (error?.code === 'AGY_NATIVE_LOCK_BUSY') {
          throw migrationError('a legacy channel lock is held; stop all old writers before migration', 'AGY_STATE_MIGRATION_LOCKED', error);
        }
        throw migrationError('a legacy native channel lock could not be acquired', 'AGY_STATE_MIGRATION_UNSAFE_FILE', error);
      }
      try {
        const [opened, pathStat] = await Promise.all([
          fstatAsync(lock.fd, { bigint: true }), lstat(path, { bigint: true })
        ]);
        if (!opened.isFile() || !pathStat.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino ||
            opened.nlink !== 1n || pathStat.nlink !== 1n) {
          throw migrationError('a legacy native lock changed while being acquired', 'AGY_STATE_MIGRATION_UNSAFE_FILE');
        }
      } catch (error) {
        await lock.release().catch(() => {});
        throw error;
      }
      locks.push(lock);
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release().catch(() => {});
    throw error;
  }
}

async function verifyStage(stageDir, expectedOwner, expectedRelay, records) {
  const expectedNames = [SESSION_STATE_STORE_MARKER, ...records.map((record) => record.destinationName)].sort();
  const actualNames = (await readdir(stageDir)).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw migrationError('the staged canonical store is incomplete or contains unexpected files', 'AGY_STATE_MIGRATION_STAGE_INVALID');
  }
  const markerText = (await readSessionStateFile(sessionStateStoreMarkerPath(stageDir), 1024)).text;
  const marker = JSON.parse(markerText);
  try { validateSessionStateStoreMarker(marker, { owner: expectedOwner, relayHash: expectedRelay }); }
  catch (error) { throw migrationError('the staged canonical store marker is invalid', 'AGY_STATE_MIGRATION_STAGE_INVALID', error); }
  if (markerText !== `${JSON.stringify(marker)}\n`) {
    throw migrationError('the staged canonical store marker is invalid', 'AGY_STATE_MIGRATION_STAGE_INVALID');
  }
  for (const migrated of records) {
    const file = await readSessionStateFile(join(stageDir, migrated.destinationName), MAX_RECORD_BYTES);
    const record = JSON.parse(file.text);
    validateSessionRecord(record);
    if (record.scope.channelId !== canonicalChannelId(record.scope.channelId) ||
        file.text !== migrated.text || record.status !== migrated.record.status) {
      throw migrationError('a staged canonical session record does not match its validated source', 'AGY_STATE_MIGRATION_STAGE_INVALID');
    }
  }
}

async function buildStage(stageDir, owner, relayHash, records) {
  await mkdir(stageDir, { mode: 0o700 });
  await chmod(stageDir, 0o700);
  for (const record of records) {
    const path = join(stageDir, record.destinationName);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(record.text, 'utf8'); }
    finally { await handle.close(); }
    await chmod(path, 0o600);
  }
  // A partial stage must remain unmarked so runtime initialization refuses it.
  // Publish its marker only after every validated record has been copied.
  const marker = await open(sessionStateStoreMarkerPath(stageDir), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await marker.writeFile(`${JSON.stringify(createSessionStateStoreMarker(owner, relayHash))}\n`, 'utf8'); }
  finally { await marker.close(); }
  await verifyStage(stageDir, owner, relayHash, records);
}

export async function migrateLegacySessionState({ sourceDir, destinationDir, owner, relay, apply = false } = {}) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim() || !isAbsolute(sourceDir) ||
      typeof destinationDir !== 'string' || !destinationDir.trim() || !isAbsolute(destinationDir) ||
      typeof apply !== 'boolean') {
    throw migrationError('source and destination must be absolute paths and apply must be boolean', 'AGY_STATE_MIGRATION_ARGUMENT');
  }
  const source = resolve(sourceDir);
  const destination = resolve(destinationDir);
  const sessionState = new SessionState({ dir: source, owner, relay });
  if (!sessionState.enabled) {
    throw migrationError(sessionState.configurationError ?? 'session owner and relay are required', 'AGY_STATE_MIGRATION_ARGUMENT');
  }
  if (within(source, destination) || within(destination, source)) {
    throw migrationError('source and destination must be separate directory trees', 'AGY_STATE_MIGRATION_UNSAFE_PATH');
  }
  await checkPath(source);
  await checkPath(destination);
  await assertPrivateDirectory(source, 'AGY_STATE_MIGRATION_UNSAFE_PATH');
  await assertPrivateDirectory(dirname(destination), 'AGY_STATE_MIGRATION_UNSAFE_PATH');
  if (await lstat(destination).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw migrationError('destination could not be inspected safely', 'AGY_STATE_MIGRATION_UNSAFE_PATH', error);
  })) {
    throw migrationError('destination must be absent before migration', 'AGY_STATE_MIGRATION_DESTINATION_EXISTS');
  }

  const expectedOwner = sessionState.owner;
  const expectedRelay = sessionState.relay;
  let scan = await scanLegacyStore(source, expectedOwner, expectedRelay);
  const sourceLocks = await acquireSourceLocks(scan);
  let destinationLock;
  let stageDir;
  let published = false;
  let operationError;
  try {
    const confirmed = await scanLegacyStore(source, expectedOwner, expectedRelay);
    if (!sameScan(scan, confirmed)) {
      throw migrationError('the legacy source changed while acquiring its locks', 'AGY_STATE_MIGRATION_SOURCE_CHANGED');
    }
    scan = confirmed;
    destinationLock = await acquireSessionStateStoreInitializationLock(destination);
    if (await lstat(destination).then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    })) {
      throw migrationError('destination must remain absent throughout migration', 'AGY_STATE_MIGRATION_DESTINATION_EXISTS');
    }

    const recordCount = scan.records.length;
    const blockedCount = scan.records.filter(({ record }) => record.status === 'blocked').length;
    if (!apply) {
      const unchanged = await scanLegacyStore(source, expectedOwner, expectedRelay);
      if (!sameScan(scan, unchanged)) {
        throw migrationError('the legacy source changed during dry-run validation', 'AGY_STATE_MIGRATION_SOURCE_CHANGED');
      }
      return { applied: false, recordCount, blockedCount };
    }

    stageDir = join(dirname(destination), `.${basename(destination)}.agy-stage-${randomUUID()}`);
    if (await lstat(stageDir).then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    })) {
      throw migrationError('staging path unexpectedly exists', 'AGY_STATE_MIGRATION_STAGE_INVALID');
    }
    try { await buildStage(stageDir, expectedOwner, expectedRelay, scan.records); }
    catch (error) {
      error.stagedPath = stageDir;
      throw error;
    }
    const unchanged = await scanLegacyStore(source, expectedOwner, expectedRelay);
    if (!sameScan(scan, unchanged)) {
      throw migrationError('the legacy source changed before publication', 'AGY_STATE_MIGRATION_SOURCE_CHANGED');
    }
    if (await lstat(destination).then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    })) {
      throw migrationError('destination must remain absent throughout migration', 'AGY_STATE_MIGRATION_DESTINATION_EXISTS');
    }
    await rename(stageDir, destination);
    published = true;
    return { applied: true, recordCount, blockedCount };
  } catch (error) {
    operationError = error;
    if (stageDir && !published && error.stagedPath === undefined) error.stagedPath = stageDir;
    throw error;
  } finally {
    let releaseFailure;
    try { await destinationLock?.release(); }
    catch (error) { releaseFailure = error; }
    for (const lock of sourceLocks.reverse()) {
      try { await lock.release(); }
      catch (error) { releaseFailure ??= error; }
    }
    if (releaseFailure && operationError) operationError.lockReleaseError = releaseFailure;
    else if (releaseFailure) {
      const error = migrationError('one or more migration locks could not be released', 'AGY_STATE_MIGRATION_LOCK_RELEASE', releaseFailure);
      error.published = published;
      throw error;
    }
  }
}
