import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, relative, resolve, sep, parse as parsePath } from 'node:path';
import { TextDecoder } from 'node:util';

export const PACKAGE_NAME = 'agy-buzz-acp';
const REQUIRED_FILES = ['package.json', 'bin/agy-buzz-acp.js'];
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const RECEIPT_SUFFIX = '.receipt.json';
const JOURNAL_SUFFIX = '.agy-journal.json';
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_MANAGER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MANAGER_CLAIMS = 64;
const MANAGER_OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGER_JOURNAL_PHASES = new Set([
  'planned', 'preparing-version', 'version-staged', 'publishing-version', 'version-published',
  'staging-harness', 'harness-staged', 'ready-to-claim', 'claiming-harness', 'harness-claimed',
  'publishing-harness', 'harness-published', 'staging-rollback', 'rollback-staged',
  'claiming-current-harness', 'current-harness-claimed', 'publishing-rollback', 'rollback-published',
  'complete', 'failed'
]);
const MANAGER_INSTALL_PHASES = new Set([
  'planned', 'preparing-version', 'version-staged', 'publishing-version', 'version-published',
  'staging-harness', 'harness-staged', 'ready-to-claim', 'claiming-harness', 'harness-claimed',
  'publishing-harness', 'harness-published', 'complete', 'failed'
]);
const MANAGER_ROLLBACK_PHASES = new Set([
  'planned', 'staging-rollback', 'rollback-staged', 'ready-to-claim', 'claiming-current-harness',
  'current-harness-claimed', 'publishing-rollback', 'rollback-published', 'complete', 'failed'
]);
const MANAGER_CLAIM_PHASES = new Set([
  'ready-to-claim', 'claiming-harness', 'harness-claimed', 'publishing-harness', 'harness-published',
  'claiming-current-harness', 'current-harness-claimed', 'publishing-rollback', 'rollback-published', 'complete'
]);
const MANAGER_SAFE_FAILURE_RE = /^[A-Za-z0-9_:-]{1,64}$/;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function managerJournalPath(harness) {
  return `${resolve(harness)}${JOURNAL_SUFFIX}`;
}

function sameManagerPath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function managerPathInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function optionalSameManagerPath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length > 0 && right.length > 0 &&
    !left.includes('\0') && !right.includes('\0') && sameManagerPath(left, right);
}

function managerPath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) && !value.includes('\0') && parsePath(resolve(value)).root
    ? resolve(value)
    : null;
}

function managerMetadataIdentity(metadata) {
  if (!metadata || metadata.isSymbolicLink() || metadata.dev === undefined || metadata.ino === undefined || metadata.ino === 0) return null;
  return `${String(metadata.dev)}:${String(metadata.ino)}`;
}

function setManagerFileIdentity(result, metadata) {
  const identity = managerMetadataIdentity(metadata);
  if (!identity) return;
  Object.defineProperty(result, 'identity', { value: identity, enumerable: false });
}

function sameManagerFileIdentity(left, right) {
  return typeof left?.identity === 'string' && left.identity.length > 0 && left.identity === right?.identity;
}

function sameManagerFileMetadata(left, right) {
  const leftIdentity = managerMetadataIdentity(left);
  const rightIdentity = managerMetadataIdentity(right);
  return Boolean(leftIdentity && leftIdentity === rightIdentity && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
}

async function readBoundedManagerFileBytes(path, maxBytes = MAX_MANAGER_FILE_BYTES) {
  const result = { path, present: false, regular: false, digest: null, reason: null };
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') { result.reason = 'missing'; return result; }
    result.reason = 'unreadable';
    return result;
  }
  result.present = true;
  setManagerFileIdentity(result, metadata);
  if (metadata.isSymbolicLink()) { result.reason = 'symlink'; return result; }
  if (!metadata.isFile()) { result.reason = 'not-regular'; return result; }
  if (!managerMetadataIdentity(metadata)) { result.reason = 'identity-unavailable'; return result; }
  result.regular = true;
  let handle;
  try {
    handle = await open(path, 'r');
    const openedMetadata = await handle.stat();
    if (!sameManagerFileMetadata(metadata, openedMetadata)) { result.reason = 'changed'; return result; }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maxBytes) {
      result.reason = 'too-large';
      return result;
    }
    const finalMetadata = await handle.stat();
    if (!sameManagerFileMetadata(openedMetadata, finalMetadata) || finalMetadata.size !== offset) {
      result.reason = 'changed';
      return result;
    }
    let finalPathMetadata;
    try { finalPathMetadata = await lstat(path); }
    catch (error) {
      result.reason = error?.code === 'ENOENT' ? 'changed' : 'unreadable';
      return result;
    }
    if (!sameManagerFileMetadata(openedMetadata, finalPathMetadata)) {
      result.reason = 'changed';
      return result;
    }
    result.digest = bytesDigest(buffer.subarray(0, offset));
    Object.defineProperty(result, 'bytes', { value: buffer.subarray(0, offset), enumerable: false });
    return result;
  } catch {
    result.reason = 'unreadable';
    return result;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readBoundedManagerFile(path, maxBytes = MAX_MANAGER_FILE_BYTES) {
  return readBoundedManagerFileBytes(path, maxBytes);
}

async function readBoundedJson(path, maxBytes) {
  const file = await readBoundedManagerFileBytes(path, maxBytes);
  if (file.reason || !file.bytes) return { file, value: null };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
  catch { file.reason = 'invalid-utf8'; return { file, value: null }; }
  try { return { file, value: JSON.parse(text) }; }
  catch { file.reason = 'invalid-json'; return { file, value: null }; }
}

function managerJournalTemplate(plan) {
  const install = plan.action === 'install';
  const now = Date.now();
  const harnessPath = resolve(install ? plan.harnessPath : plan.harness);
  const journalPath = resolve(plan.journalPath ?? managerJournalPath(harnessPath));
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operationId: randomUUID(),
    action: plan.action,
    phase: 'planned',
    phaseHistory: [{ phase: 'planned', at: now }],
    startedAt: now,
    updatedAt: now,
    harnessPath,
    journalPath,
    root: resolve(install ? plan.root : dirname(plan.harness)),
    destination: install ? resolve(plan.destination) : null,
    entrypoint: install ? resolve(plan.entrypoint) : null,
    archivePath: install ? resolve(plan.archive) : null,
    archiveSha256: install ? plan.sha256 : null,
    backupPath: resolve(install ? plan.backupPath : plan.backup),
    receiptPath: resolve(plan.receiptPath),
    previousEntrypoint: resolve(plan.receipt.previousEntrypoint),
    currentEntrypoint: resolve(plan.receipt.installedEntrypoint),
    expectedHarnessDigest: install ? bytesDigest(plan.harness.originalBytes) : bytesDigest(plan.currentBytes),
    expectedTargetDigest: install ? bytesDigest(plan.harness.installedBytes) : bytesDigest(plan.originalBytes),
    claimPath: null,
    claimDigest: null,
    failureCode: null
  };
}

function validateManagerJournal(value, journalPath) {
  const allowedFields = new Set([
    'schemaVersion', 'operationId', 'action', 'phase', 'phaseHistory', 'startedAt', 'updatedAt',
    'harnessPath', 'journalPath', 'root', 'destination', 'entrypoint', 'archivePath', 'archiveSha256',
    'backupPath', 'receiptPath', 'previousEntrypoint', 'currentEntrypoint', 'expectedHarnessDigest',
    'expectedTargetDigest', 'claimPath', 'claimDigest', 'failureCode'
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((field) => !allowedFields.has(field)) ||
      value.schemaVersion !== JOURNAL_SCHEMA_VERSION || !MANAGER_OPERATION_ID_RE.test(value.operationId ?? '') ||
      !['install', 'rollback'].includes(value.action) || !MANAGER_JOURNAL_PHASES.has(value.phase) ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.updatedAt) ||
      !Array.isArray(value.phaseHistory) || value.phaseHistory.length === 0 || value.phaseHistory.length > 32 ||
      !managerPath(value.harnessPath) || !managerPath(value.journalPath) || !sameManagerPath(value.journalPath, journalPath) ||
      !managerPath(value.root) || !managerPath(value.backupPath) || !managerPath(value.receiptPath) ||
      !/^[a-f0-9]{64}$/i.test(value.expectedHarnessDigest ?? '') ||
      !/^[a-f0-9]{64}$/i.test(value.expectedTargetDigest ?? '')) return null;
  const phaseSet = value.action === 'install' ? MANAGER_INSTALL_PHASES : MANAGER_ROLLBACK_PHASES;
  if (!phaseSet.has(value.phase) || value.phaseHistory.some((entry) =>
    !entry || typeof entry !== 'object' || !phaseSet.has(entry.phase) || !Number.isSafeInteger(entry.at))) return null;
  if (value.phaseHistory.at(-1).phase !== value.phase || value.startedAt > value.updatedAt) return null;
  let previousPhaseAt = value.startedAt;
  for (const entry of value.phaseHistory) {
    if (entry.at < previousPhaseAt || entry.at > value.updatedAt) return null;
    previousPhaseAt = entry.at;
  }
  const pathFields = ['destination', 'entrypoint', 'archivePath', 'backupPath', 'receiptPath', 'previousEntrypoint', 'currentEntrypoint'];
  for (const field of pathFields) {
    if (value[field] !== null && !managerPath(value[field])) return null;
  }
  if (!sameManagerPath(value.receiptPath, `${value.backupPath}${RECEIPT_SUFFIX}`) ||
      !managerPath(value.previousEntrypoint) || !managerPath(value.currentEntrypoint)) return null;
  if (value.action === 'install') {
    if (!managerPath(value.destination) || !managerPath(value.entrypoint) || !managerPath(value.archivePath) ||
        !value.archiveSha256 || !managerPathInside(join(value.root, 'versions'), value.destination) ||
        !managerPathInside(value.destination, value.entrypoint)) return null;
  } else if (value.destination !== null || value.entrypoint !== null || value.archivePath !== null || value.archiveSha256 !== null) return null;
  if (value.archiveSha256 !== null && !/^[a-f0-9]{64}$/i.test(value.archiveSha256 ?? '')) return null;
  if (value.claimPath !== null && !managerPath(value.claimPath)) return null;
  if (value.claimDigest !== null && !/^[a-f0-9]{64}$/i.test(value.claimDigest ?? '')) return null;
  if (value.failureCode !== null && !MANAGER_SAFE_FAILURE_RE.test(value.failureCode ?? '')) return null;
  if (MANAGER_CLAIM_PHASES.has(value.phase) && (!value.claimPath || !value.claimDigest)) return null;
  if (value.claimPath === null && value.claimDigest !== null) return null;
  if (value.claimPath !== null && value.claimDigest === null && value.phase !== 'failed') return null;
  if (value.claimPath !== null) {
    const claimName = basename(value.claimPath);
    const harnessName = basename(value.harnessPath);
    if (!claimName.startsWith(`${harnessName}.claim-`) && !claimName.startsWith(`${harnessName}.rollback-current-`)) return null;
  }
  return value;
}

async function writeManagerJournal(path, value) {
  await assertNoSymlinkAncestors(path);
  const existing = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) fail('manager journal must be a regular file');
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function startManagerJournal(path, value) {
  const existing = await readBoundedJson(path, MAX_JOURNAL_BYTES);
  if (existing.file.present) {
    const previous = validateManagerJournal(existing.value, path);
    if (!previous || previous.phase !== 'complete') {
      fail('existing manager journal is incomplete or ambiguous; inspect before starting a new operation');
    }
  }
  await writeManagerJournal(path, value);
}

async function advanceManagerJournal(path, journal, phase, updates = {}) {
  if (!MANAGER_JOURNAL_PHASES.has(phase)) fail('manager journal phase is invalid');
  const now = Date.now();
  const next = {
    ...journal,
    ...updates,
    phase,
    updatedAt: now,
    phaseHistory: [...journal.phaseHistory, { phase, at: now }].slice(-32)
  };
  await writeManagerJournal(path, next);
  return next;
}

async function markManagerJournalFailure(path, journal, error) {
  const failureCode = MANAGER_SAFE_FAILURE_RE.test(error?.code ?? '') ? error.code : 'operation-failed';
  try { await advanceManagerJournal(path, journal, 'failed', { failureCode }); }
  catch { /* Preserve the original operation failure and all durable evidence. */ }
}

function parseTarNumber(bytes, start, length, label) {
  const text = bytes.toString('ascii', start, start + length).replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) fail(`archive has an invalid ${label}`);
  return Number.parseInt(text, 8);
}

function tarName(header) {
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function safeArchivePath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.includes(':') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    fail(`archive contains an unsafe path: ${name || '<empty>'}`);
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) fail(`archive path traversal or Windows-unsafe name is not allowed: ${name}`);
  if (parts[0] !== 'package' || parts.length < 2) fail(`archive path must be under package/: ${name}`);
  return parts.slice(1).join('/');
}

function parseTar(gzipBytes) {
  if (gzipBytes.length > MAX_ARCHIVE_BYTES) fail('archive exceeds the 128 MiB limit');
  let bytes;
  try { bytes = gunzipSync(gzipBytes, { maxOutputLength: MAX_ARCHIVE_BYTES }); } catch { fail('archive is not a valid gzip stream or exceeds the decompressed size limit'); }
  const entries = [];
  const names = new Set();
  const foldedNames = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    const name = tarName(header);
    const path = safeArchivePath(name);
    const expectedChecksum = parseTarNumber(header, 148, 8, 'header checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) fail(`archive has an invalid header checksum: ${name}`);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type !== '0' && type !== '5') fail(`archive contains unsupported ${type === '1' || type === '2' ? 'link' : 'entry'}: ${name}`);
    const size = parseTarNumber(header, 124, 12, 'file size');
    if (!Number.isSafeInteger(size) || size > bytes.length - offset) fail(`archive entry has an invalid size: ${name}`);
    if (names.has(path) || foldedNames.has(path.toLowerCase())) fail(`archive contains a duplicate or case-colliding path: ${name}`);
    names.add(path);
    foldedNames.add(path.toLowerCase());
    entries.push({ name: path, type, content: type === '0' ? Buffer.from(bytes.subarray(offset, offset + size)) : null });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || offset > bytes.length) fail('archive has no valid tar end marker');
  if (bytes.subarray(offset).some((byte) => byte !== 0)) fail('archive has unsupported trailing data');
  return entries;
}

function bundledDependencies(manifest) {
  if (manifest.bundledDependencies === undefined) return new Set();
  if (!Array.isArray(manifest.bundledDependencies) || manifest.bundledDependencies.some((name) => typeof name !== 'string' || !PACKAGE_NAME_RE.test(name))) {
    fail('archive bundled dependencies must be a list of valid package names');
  }
  const names = new Set(manifest.bundledDependencies);
  if (names.size !== manifest.bundledDependencies.length) fail('archive bundled dependencies contain duplicates');
  return names;
}

function validateBundledPath(name, type, bundles) {
  const parts = name.split('/');
  if (parts[0] !== 'node_modules') return false;
  if (parts.length === 1) {
    if (type !== '5') fail(`archive contains an invalid node_modules entry: ${name}`);
    return true;
  }
  let packageName;
  let contentStart;
  if (parts[1].startsWith('@')) {
    if (parts.length < 3) fail(`archive contains an invalid bundled package path: ${name}`);
    packageName = `${parts[1]}/${parts[2]}`;
    contentStart = 3;
  } else {
    packageName = parts[1];
    contentStart = 2;
  }
  if (!PACKAGE_NAME_RE.test(packageName) || !bundles.has(packageName)) {
    fail(`archive file is not explicitly bundled: ${name}`);
  }
  const content = parts.slice(contentStart);
  if (content.includes('node_modules')) fail(`archive contains an undeclared nested dependency: ${name}`);
  if (type === '0' && content.length === 0) fail(`archive bundled package path is not a file: ${name}`);
  return true;
}

function validatePackage(entries) {
  const files = new Map(entries.filter((entry) => entry.type === '0').map((entry) => [entry.name, entry.content]));
  for (const required of REQUIRED_FILES) if (!files.has(required)) fail(`archive is missing package/${required}`);
  const manifest = parseJson(files.get('package.json'), 'package/package.json');
  if (!isPlainObject(manifest) || manifest.name !== PACKAGE_NAME) fail(`archive package name must be ${PACKAGE_NAME}`);
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) fail('archive package version is invalid');
  if (!Array.isArray(manifest.files) || manifest.files.some((value) => typeof value !== 'string')) fail('archive package files must be a string array');
  const bundles = bundledDependencies(manifest);
  for (const entry of entries) {
    const { name } = entry;
    if (name === 'package.json') continue;
    if (name === 'node_modules' || name.startsWith('node_modules/')) {
      validateBundledPath(name, entry.type, bundles);
      continue;
    }
    if (entry.type !== '0') continue;
    if (!manifest.files.some((listed) => name === listed || name.startsWith(`${listed.replace(/\/$/, '')}/`))) fail(`archive file is not listed by package files: ${name}`);
    if (name.startsWith('test/') || name.startsWith('node_modules/') || name.startsWith('.git/')) fail(`archive contains an unexpected package file: ${name}`);
  }
  return { name: manifest.name, version: manifest.version, files: [...files.keys()], manifest };
}

async function readHarness(path) {
  const bytes = await readFile(path);
  const config = parseJson(bytes, 'harness configuration');
  if (!isPlainObject(config) || typeof config.id !== 'string' || typeof config.label !== 'string' || typeof config.command !== 'string' || !Array.isArray(config.args) || !config.args.length || config.args.some((arg) => typeof arg !== 'string') || !isPlainObject(config.env) || Object.values(config.env).some((value) => typeof value !== 'string')) {
    fail('harness configuration has an invalid identity or command shape');
  }
  if (basename(config.args[0]).toLowerCase() !== 'agy-buzz-acp.js') fail('harness args[0] must be the agy-buzz-acp.js adapter entrypoint');
  return { bytes, config };
}

function sameExceptArgs(a, b) {
  const copy = (value) => JSON.stringify({ ...value, args: undefined });
  return copy(a) === copy(b) && a.args.length === b.args.length && JSON.stringify(a.args.slice(1)) === JSON.stringify(b.args.slice(1));
}

function ensureInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail('destination escapes the runtime root');
}

async function assertNoSymlinkAncestors(target) {
  let current = resolve(target);
  const filesystemRoot = parsePath(current).root;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) fail(`symlink or junction in path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
}

async function withManagerLock(harnessPath, operation) {
  const lockPath = `${harnessPath}.agy-lock`;
  await assertNoSymlinkAncestors(lockPath);
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('another manager operation is in progress');
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function restoreClaimIfAbsent(claim, target) {
  try {
    await link(claim, target);
  } catch (error) {
    if (error.code === 'EEXIST') fail('concurrent configuration won the final publish window; preserved its bytes in the claim file');
    throw error;
  }
}

export async function planInstall({ archive, sha256, root, harness }) {
  if (typeof archive !== 'string' || typeof root !== 'string' || typeof harness !== 'string') fail('archive, root and harness are required');
  if (!SHA256_RE.test(String(sha256 ?? ''))) fail('sha256 must be a 64-character hexadecimal digest');
  const archiveDetails = await stat(archive);
  if (!archiveDetails.isFile() || archiveDetails.size > MAX_ARCHIVE_BYTES) fail('archive is missing or exceeds the 128 MiB compressed size limit');
  const gzipBytes = await readFile(archive);
  const digest = createHash('sha256').update(gzipBytes).digest('hex');
  if (digest.toLowerCase() !== String(sha256).toLowerCase()) fail('archive sha256 does not match expected digest');
  const entries = parseTar(gzipBytes);
  const pkg = validatePackage(entries);
  const current = await readHarness(harness);
  const rootPath = resolve(root);
  const harnessPath = resolve(harness);
  await assertNoSymlinkAncestors(rootPath);
  await assertNoSymlinkAncestors(join(rootPath, 'versions'));
  await assertNoSymlinkAncestors(harnessPath);
  const versionsRoot = join(rootPath, 'versions');
  const destination = join(versionsRoot, `${pkg.name}-${pkg.version}`);
  ensureInside(root, destination);
  const entrypoint = join(destination, 'bin', 'agy-buzz-acp.js');
  const after = { ...current.config, args: [entrypoint, ...current.config.args.slice(1)] };
  const backupPath = `${harnessPath}.${Date.now()}-${randomUUID()}.backup`;
  const installedBytes = Buffer.from(`${JSON.stringify(after, null, 2)}\n`, 'utf8');
  return {
    action: 'install', apply: false, archive, sha256: digest, root: rootPath, harnessPath,
    package: { name: pkg.name, version: pkg.version, files: pkg.files }, destination, entrypoint,
    backupPath, receiptPath: `${backupPath}${RECEIPT_SUFFIX}`, journalPath: managerJournalPath(harnessPath),
    harness: { before: current.config, after, originalBytes: current.bytes, installedBytes },
    receipt: {
      version: 1, harnessPath, backupPath, originalDigest: bytesDigest(current.bytes), installedDigest: bytesDigest(installedBytes),
      previousEntrypoint: current.config.args[0], installedEntrypoint: entrypoint
    }, entries
  };
}

async function writeExtracted(plan, temporary) {
  for (const entry of plan.entries) {
    const destination = join(temporary, entry.name);
    ensureInside(temporary, destination);
    if (entry.type === '5') {
      await mkdir(destination, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, { flag: 'wx', mode: 0o644 });
  }
}

export async function applyInstall(plan, { beforePublish, afterClaim } = {}) {
  if (!plan || plan.action !== 'install') fail('invalid install plan');
  return withManagerLock(plan.harnessPath, async () => {
    const backup = plan.backupPath;
    const journalPath = resolve(plan.journalPath ?? managerJournalPath(plan.harnessPath));
    let journal = managerJournalTemplate(plan);
    await startManagerJournal(journalPath, journal);
    try {
      await stat(plan.harnessPath);
      const currentBytes = await readFile(plan.harnessPath);
      if (!currentBytes.equals(plan.harness.originalBytes)) fail('harness changed after the install plan; refusing a configuration conflict');
      await assertNoSymlinkAncestors(plan.harnessPath);
      await assertNoSymlinkAncestors(plan.backupPath);
      await assertNoSymlinkAncestors(plan.receiptPath);
      await assertNoSymlinkAncestors(join(plan.root, 'versions'));
      await lstat(backup).then(() => fail(`backup already exists: ${backup}`), (error) => { if (error.code !== 'ENOENT') throw error; });
      await lstat(plan.destination).then(() => fail(`version directory already exists: ${plan.destination}`), (error) => { if (error.code !== 'ENOENT') throw error; });
      journal = await advanceManagerJournal(journalPath, journal, 'preparing-version');
      await mkdir(join(plan.root, 'versions'), { recursive: true });
      const temporary = await mkdtemp(join(join(plan.root, 'versions'), '.agy-install-'));
      await writeExtracted(plan, temporary);
      await stat(join(temporary, relative(plan.destination, plan.entrypoint)));
      journal = await advanceManagerJournal(journalPath, journal, 'version-staged');
      journal = await advanceManagerJournal(journalPath, journal, 'publishing-version');
      await rename(temporary, plan.destination);
      journal = await advanceManagerJournal(journalPath, journal, 'version-published');
      const beforeWrite = await readFile(plan.harnessPath);
      if (!beforeWrite.equals(plan.harness.originalBytes)) fail('harness changed during installation; refusing a configuration conflict');
      await lstat(backup).then(() => fail(`backup already exists: ${backup}`), (error) => { if (error.code !== 'ENOENT') throw error; });
      await lstat(plan.receiptPath).then(() => fail(`receipt already exists: ${plan.receiptPath}`), (error) => { if (error.code !== 'ENOENT') throw error; });
      journal = await advanceManagerJournal(journalPath, journal, 'staging-harness');
      const stage = await mkdtemp(join(dirname(plan.harnessPath), '.agy-harness-'));
      const stagedHarness = join(stage, 'harness.json');
      const stagedReceipt = join(stage, 'receipt.json');
      await writeFile(stagedHarness, plan.harness.installedBytes, { flag: 'wx', mode: 0o600 });
      await writeFile(stagedReceipt, `${JSON.stringify(plan.receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      journal = await advanceManagerJournal(journalPath, journal, 'harness-staged');
      await beforePublish?.();
      const claim = `${plan.harnessPath}.claim-${randomUUID()}`;
      await assertNoSymlinkAncestors(claim);
      journal = await advanceManagerJournal(journalPath, journal, 'ready-to-claim', { claimPath: claim });
      journal = await advanceManagerJournal(journalPath, journal, 'claiming-harness');
      try {
        await rename(plan.harnessPath, claim);
      } catch {
        fail('harness disappeared during installation; refusing a configuration conflict');
      }
      const claimedBytes = await readFile(claim);
      if (!claimedBytes.equals(plan.harness.originalBytes)) {
        await restoreClaimIfAbsent(claim, plan.harnessPath);
        fail('concurrent configuration won the final publish window; preserved its bytes in the claim file');
      }
      journal = await advanceManagerJournal(journalPath, journal, 'harness-claimed', { claimDigest: bytesDigest(claimedBytes) });
      await afterClaim?.({ claimPath: claim });
      journal = await advanceManagerJournal(journalPath, journal, 'publishing-harness');
      try {
        await link(claim, backup);
        await link(stagedReceipt, plan.receiptPath);
        await link(stagedHarness, plan.harnessPath);
      } catch (error) {
        await restoreClaimIfAbsent(claim, plan.harnessPath).catch(() => {});
        throw error;
      }
      journal = await advanceManagerJournal(journalPath, journal, 'harness-published');
      await unlink(stagedHarness).catch(() => {});
      await unlink(stagedReceipt).catch(() => {});
      journal = await advanceManagerJournal(journalPath, journal, 'complete');
      return { action: 'install', applied: true, root: plan.root, harnessPath: plan.harnessPath, destination: plan.destination, entrypoint: plan.entrypoint, backupPath: backup, receiptPath: plan.receiptPath, journalPath, package: plan.package };
    } catch (error) {
      await markManagerJournalFailure(journalPath, journal, error);
      throw error;
    }
  });
}

export async function planRollback({ backup, harness }) {
  if (typeof backup !== 'string' || typeof harness !== 'string') fail('backup and harness are required');
  const previous = await readHarness(backup);
  const current = await readHarness(harness);
  const receiptPath = `${resolve(backup)}${RECEIPT_SUFFIX}`;
  await assertNoSymlinkAncestors(resolve(harness));
  await assertNoSymlinkAncestors(resolve(backup));
  await assertNoSymlinkAncestors(receiptPath);
  const receipt = parseJson(await readFile(receiptPath), 'install receipt');
  if (!isPlainObject(receipt) || receipt.version !== 1 || receipt.harnessPath !== resolve(harness) || receipt.backupPath !== resolve(backup) || receipt.originalDigest !== bytesDigest(previous.bytes) || receipt.installedDigest !== bytesDigest(current.bytes) || receipt.previousEntrypoint === receipt.installedEntrypoint || receipt.previousEntrypoint !== previous.config.args[0] || receipt.installedEntrypoint !== current.config.args[0]) fail('install receipt or harness association conflict prevents rollback');
  if (sameExceptArgs(previous.config, current.config) === false) fail('harness identity or association conflict prevents rollback');
  try {
    if (!(await stat(current.config.args[0])).isFile()) fail('current adapter entrypoint is not a file');
  } catch {
    fail('current adapter entrypoint does not exist');
  }
  try {
    if (!(await stat(previous.config.args[0])).isFile()) fail('previous adapter entrypoint is not a file');
  } catch {
    fail('previous adapter entrypoint does not exist');
  }
  return { action: 'rollback', apply: false, backup: resolve(backup), receiptPath, journalPath: managerJournalPath(harness), harness: resolve(harness), originalBytes: previous.bytes, currentBytes: current.bytes, current: current.config, previous: previous.config, receipt };
}

export async function applyRollback(plan, { beforePublish, afterClaim } = {}) {
  if (!plan || plan.action !== 'rollback') fail('invalid rollback plan');
  return withManagerLock(plan.harness, async () => {
    const journalPath = resolve(plan.journalPath ?? managerJournalPath(plan.harness));
    let journal = managerJournalTemplate(plan);
    await startManagerJournal(journalPath, journal);
    try {
      const fresh = await planRollback({ backup: plan.backup, harness: plan.harness });
      if (!fresh.originalBytes.equals(plan.originalBytes) || !fresh.currentBytes.equals(plan.currentBytes)) fail('configuration changed after the rollback plan; refusing a configuration conflict');
      journal = await advanceManagerJournal(journalPath, journal, 'staging-rollback');
      const stage = await mkdtemp(join(dirname(plan.harness), '.agy-rollback-'));
      const staged = join(stage, 'harness.json');
      try {
        await writeFile(staged, fresh.originalBytes, { flag: 'wx', mode: 0o600 });
        journal = await advanceManagerJournal(journalPath, journal, 'rollback-staged');
        await beforePublish?.();
        const claim = `${plan.harness}.rollback-current-${randomUUID()}`;
        await assertNoSymlinkAncestors(claim);
        journal = await advanceManagerJournal(journalPath, journal, 'ready-to-claim', { claimPath: claim });
        journal = await advanceManagerJournal(journalPath, journal, 'claiming-current-harness');
        try {
          await rename(plan.harness, claim);
        } catch {
          fail('harness disappeared during rollback; refusing a configuration conflict');
        }
        const claimedBytes = await readFile(claim);
        if (!claimedBytes.equals(plan.currentBytes)) {
          await restoreClaimIfAbsent(claim, plan.harness);
          fail('concurrent configuration won the final rollback window; preserved its bytes in the claim file');
        }
        journal = await advanceManagerJournal(journalPath, journal, 'current-harness-claimed', { claimDigest: bytesDigest(claimedBytes) });
        await afterClaim?.({ claimPath: claim });
        journal = await advanceManagerJournal(journalPath, journal, 'publishing-rollback');
        try {
          await link(staged, plan.harness);
        } catch (error) {
          await restoreClaimIfAbsent(claim, plan.harness).catch(() => {});
          throw error;
        }
        journal = await advanceManagerJournal(journalPath, journal, 'rollback-published');
        journal = await advanceManagerJournal(journalPath, journal, 'complete');
        return { action: 'rollback', applied: true, harness: plan.harness, backup: plan.backup, receiptPath: plan.receiptPath, journalPath, currentBackupPath: claim };
      } finally {
        await unlink(staged).catch(() => {});
        await rmdir(stage).catch(() => {});
      }
    } catch (error) {
      await markManagerJournalFailure(journalPath, journal, error);
      throw error;
    }
  });
}

function withExpectedManagerDigest(file, expectedDigest) {
  return {
    ...file,
    expectedDigest: expectedDigest ?? null,
    associated: expectedDigest
      ? Boolean(file.present && file.regular && !file.reason && file.digest === expectedDigest)
      : null
  };
}

async function inspectManagerClaims(harnessPath) {
  let entries;
  try { entries = await readdir(dirname(harnessPath), { withFileTypes: true }); }
  catch { return { claims: [], overflow: false, unreadable: true }; }
  const base = basename(harnessPath);
  const prefixes = [`${base}.claim-`, `${base}.rollback-current-`];
  const names = entries.map((entry) => entry.name).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  if (names.length > MAX_MANAGER_CLAIMS) return { claims: [], overflow: true, unreadable: false };
  const claims = [];
  for (const name of names) {
    const path = join(dirname(harnessPath), name);
    claims.push(await readBoundedManagerFile(path));
  }
  return { claims, overflow: false, unreadable: false };
}

async function inspectManagerReceipt(path, journal) {
  const loaded = await readBoundedJson(path, MAX_MANAGER_FILE_BYTES);
  const file = loaded.file;
  let associated = false;
  if (loaded.value && typeof loaded.value === 'object' && !Array.isArray(loaded.value)) {
    const receipt = loaded.value;
    associated = receipt.version === 1 && optionalSameManagerPath(receipt.harnessPath, journal.harnessPath) &&
      optionalSameManagerPath(receipt.backupPath, journal.backupPath) &&
      receipt.originalDigest === (journal.action === 'install' ? journal.expectedHarnessDigest : journal.expectedTargetDigest) &&
      receipt.installedDigest === (journal.action === 'install' ? journal.expectedTargetDigest : journal.expectedHarnessDigest) &&
      optionalSameManagerPath(receipt.previousEntrypoint, journal.previousEntrypoint) &&
      optionalSameManagerPath(receipt.installedEntrypoint, journal.currentEntrypoint);
  }
  return { ...file, associated };
}

function managerRecommendation(reason) {
  return {
    action: 'manual-inspection',
    automaticRecovery: false,
    reason
  };
}

function journalSummary(journal, path) {
  if (!journal) return { path, present: false, valid: false, reason: 'missing' };
  const {
    schemaVersion, operationId, action, phase, phaseHistory, startedAt, updatedAt,
    harnessPath, journalPath: recordedJournalPath, root, destination, entrypoint, archivePath, archiveSha256,
    backupPath, receiptPath, previousEntrypoint, currentEntrypoint,
    expectedHarnessDigest, expectedTargetDigest, claimPath, claimDigest, failureCode
  } = journal;
  return {
    path, present: true, valid: true, schemaVersion, operationId, action, phase, phaseHistory,
    startedAt, updatedAt, harnessPath, journalPath: recordedJournalPath, root, destination, entrypoint, archivePath, archiveSha256,
    backupPath, receiptPath, previousEntrypoint, currentEntrypoint,
    expectedHarnessDigest, expectedTargetDigest, claimPath, claimDigest, failureCode
  };
}

// Read-only manager inspection. It reports evidence and a conservative next
// action; it never acquires the manager marker, relinks a claim, deletes a
// staging file, or rewrites a journal.
export async function diagnoseManager({ harness, journal } = {}) {
  if (typeof harness !== 'string' || !harness.trim()) fail('harness is required');
  if (journal !== undefined && (typeof journal !== 'string' || !journal.trim())) fail('journal must be a non-empty path');
  const harnessPath = resolve(harness);
  const journalPath = journal === undefined ? managerJournalPath(harnessPath) : resolve(journal);
  const lockPath = `${harnessPath}.agy-lock`;
  await assertNoSymlinkAncestors(harnessPath);
  await assertNoSymlinkAncestors(journalPath);
  const claimsInfo = await inspectManagerClaims(harnessPath);
  const journalLoaded = await readBoundedJson(journalPath, MAX_JOURNAL_BYTES);
  const parsedJournal = validateManagerJournal(journalLoaded.value, journalPath);
  const journalFile = journalLoaded.file;
  const lockFile = await readBoundedManagerFile(lockPath, 4 * 1024);
  const markerUnresolved = lockFile.present || lockFile.reason !== 'missing';
  const harnessFile = await readBoundedManagerFile(harnessPath);
  const expectedCurrentDigest = parsedJournal ? parsedJournal.expectedTargetDigest : null;
  const report = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    status: 'insufficient-evidence',
    harnessPath,
    journal: parsedJournal ? journalSummary(parsedJournal, journalPath) : {
      path: journalPath,
      present: journalFile.present,
      valid: false,
      reason: journalFile.reason ?? 'invalid'
    },
    lock: { path: lockPath, present: lockFile.present, safe: lockFile.regular && !lockFile.reason },
    harness: withExpectedManagerDigest(harnessFile, expectedCurrentDigest),
    claim: null,
    claims: claimsInfo.claims.map((claim) => ({
      path: claim.path,
      present: claim.present,
      regular: claim.regular,
      digest: claim.digest,
      reason: claim.reason
    })),
    backup: null,
    receipt: null,
    bounds: { journalBytes: MAX_JOURNAL_BYTES, fileBytes: MAX_MANAGER_FILE_BYTES, claims: MAX_MANAGER_CLAIMS },
    recommendation: managerRecommendation('journal or complete file association evidence is missing')
  };

  if (claimsInfo.unreadable || claimsInfo.overflow) {
    report.status = 'indeterminate';
    report.recommendation = managerRecommendation('claim enumeration is incomplete or unreadable; do not restore');
    return report;
  }
  if (!parsedJournal) {
    if (markerUnresolved || claimsInfo.claims.length > 0 || journalFile.present) {
      report.status = 'indeterminate';
      report.recommendation = managerRecommendation(markerUnresolved
        ? 'manager marker is unresolved; do not restore'
        : 'manager journal is incomplete or ambiguous; do not restore');
    }
    return report;
  }
  if (!sameManagerPath(parsedJournal.harnessPath, harnessPath) ||
      (parsedJournal.claimPath && !sameManagerPath(dirname(parsedJournal.claimPath), dirname(harnessPath)))) {
    report.status = 'indeterminate';
    report.recommendation = managerRecommendation('journal paths are not associated with the requested harness; do not restore');
    return report;
  }

  const expectedClaimDigest = parsedJournal.claimDigest ?? parsedJournal.expectedHarnessDigest;
  const claimRecord = parsedJournal.claimPath
    ? await readBoundedManagerFile(parsedJournal.claimPath, MAX_MANAGER_FILE_BYTES)
    : null;
  report.claim = claimRecord
    ? withExpectedManagerDigest(claimRecord, expectedClaimDigest)
    : { path: null, present: false, regular: false, digest: null, expectedDigest: null, associated: null, reason: 'not-recorded' };
  const backupRecord = await readBoundedManagerFile(parsedJournal.backupPath, MAX_MANAGER_FILE_BYTES);
  report.backup = withExpectedManagerDigest(backupRecord,
    parsedJournal.action === 'install' ? parsedJournal.expectedHarnessDigest : parsedJournal.expectedTargetDigest);
  report.receipt = await inspectManagerReceipt(parsedJournal.receiptPath, parsedJournal);

  const historicalClaims = parsedJournal.action === 'rollback' && report.backup.associated
    ? claimsInfo.claims.filter((claim) => (!parsedJournal.claimPath || !sameManagerPath(claim.path, parsedJournal.claimPath)) &&
      claim.digest === parsedJournal.expectedTargetDigest && sameManagerFileIdentity(claim, backupRecord))
    : [];
  const extraClaims = claimsInfo.claims.filter((claim) =>
    (!parsedJournal.claimPath || !sameManagerPath(claim.path, parsedJournal.claimPath)) && !historicalClaims.includes(claim));
  const harnessConflict = harnessFile.present && !report.harness.associated;
  const claimConflict = report.claim.present && !report.claim.associated;
  const receiptConflict = report.receipt.present && !report.receipt.associated;
  if (harnessConflict || claimConflict || receiptConflict || extraClaims.length > 0) {
    report.status = 'indeterminate';
    report.recommendation = managerRecommendation('one or more files conflict with the journal digest or association; do not restore');
    return report;
  }

  const claimPhase = ['claiming-harness', 'harness-claimed', 'publishing-harness',
    'claiming-current-harness', 'current-harness-claimed', 'publishing-rollback'];
  if (!harnessFile.present && report.claim.present && report.claim.associated && claimPhase.includes(parsedJournal.phase)) {
    report.status = 'interrupted';
    report.recommendation = managerRecommendation('an interrupted claim is identified, but the journal authorizes no automatic restoration');
    return report;
  }
  if (markerUnresolved) {
    report.status = 'indeterminate';
    report.recommendation = managerRecommendation('manager marker is unresolved; do not restore');
    return report;
  }
  if (parsedJournal.phase === 'complete' && report.harness.associated && report.claim?.associated &&
      report.backup.associated && report.receipt.associated) {
    report.status = 'consistent';
    report.recommendation = managerRecommendation('files match the completed journal; no repair is required');
    return report;
  }
  if (parsedJournal.phase === 'failed') {
    report.status = 'indeterminate';
    report.recommendation = managerRecommendation('the journal records a failed operation; inspect all effects before any manual decision');
    return report;
  }
  report.status = 'insufficient-evidence';
  return report;
}

export const inspectManager = diagnoseManager;

export function parseManageArgs(argv) {
  const options = { apply: false, json: false };
  let action;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'install' || arg === 'rollback' || arg === 'diagnose') {
      if (action) fail('only one action may be selected');
      action = arg;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!['archive', 'sha256', 'root', 'harness', 'backup', 'journal'].includes(key)) fail(`unknown option: ${arg}`);
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`${arg} requires a value`);
      options[key] = argv[++index];
    } else fail(`unknown argument: ${arg}`);
  }
  if (!options.help && !action) fail('install or rollback is required');
  options.action = action;
  return options;
}

export function manageUsage() {
  return [
    'Usage:',
    '  agy-buzz-manage install --archive <tgz> --sha256 <digest> --root <runtime-dir> --harness <json> [--apply]',
    '  agy-buzz-manage rollback --backup <file> --harness <json> [--apply]',
    '  agy-buzz-manage diagnose --harness <json> [--journal <file>]',
    '',
    'Without --apply, commands print a verified plan and do not mutate files.'
  ].join('\n');
}

export async function runManageCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseManageArgs(argv);
    if (options.help) { stdout.write(`${manageUsage()}\n`); return 0; }
    if (options.action === 'diagnose') {
      if (options.apply) fail('manager diagnosis is read-only');
      const report = await diagnoseManager(options);
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const plan = options.action === 'install' ? await planInstall(options) : await planRollback(options);
    if (options.apply) {
      const applied = options.action === 'install' ? await applyInstall(plan) : await applyRollback(plan);
      stdout.write(`${JSON.stringify({ action: applied.action, applied: true, root: applied.root, destination: applied.destination, entrypoint: applied.entrypoint, package: applied.package, harnessPath: applied.harnessPath ?? applied.harness, backupPath: applied.backupPath ?? applied.backup, receiptPath: applied.receiptPath, journalPath: applied.journalPath, currentBackupPath: applied.currentBackupPath }, null, 2)}\n`);
    } else {
      stdout.write(`${JSON.stringify({ action: plan.action, apply: false, root: plan.root, destination: plan.destination, entrypoint: plan.entrypoint, package: plan.package, harnessPath: plan.harnessPath ?? plan.harness, backupPath: plan.backupPath, receiptPath: plan.receiptPath, journalPath: plan.journalPath, backup: plan.backup }, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`agy-buzz-manage: ${error.message}\n`);
    return 2;
  }
}
