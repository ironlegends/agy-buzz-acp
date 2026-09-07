import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { dirname, basename, join, relative, resolve, sep, parse as parsePath } from 'node:path';

export const PACKAGE_NAME = 'agy-buzz-acp';
const REQUIRED_FILES = ['package.json', 'bin/agy-buzz-acp.js'];
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const RECEIPT_SUFFIX = '.receipt.json';

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

function validatePackage(entries) {
  const files = new Map(entries.filter((entry) => entry.type === '0').map((entry) => [entry.name, entry.content]));
  for (const required of REQUIRED_FILES) if (!files.has(required)) fail(`archive is missing package/${required}`);
  const manifest = parseJson(files.get('package.json'), 'package/package.json');
  if (!isPlainObject(manifest) || manifest.name !== PACKAGE_NAME) fail(`archive package name must be ${PACKAGE_NAME}`);
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) fail('archive package version is invalid');
  if (!Array.isArray(manifest.files) || manifest.files.some((value) => typeof value !== 'string')) fail('archive package files must be a string array');
  for (const name of files.keys()) {
    if (name === 'package.json') continue;
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
    backupPath, receiptPath: `${backupPath}${RECEIPT_SUFFIX}`,
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

export async function applyInstall(plan, { beforePublish } = {}) {
  if (!plan || plan.action !== 'install') fail('invalid install plan');
  return withManagerLock(plan.harnessPath, async () => {
    const backup = plan.backupPath;
    await stat(plan.harnessPath);
    const currentBytes = await readFile(plan.harnessPath);
    if (!currentBytes.equals(plan.harness.originalBytes)) fail('harness changed after the install plan; refusing a configuration conflict');
    await assertNoSymlinkAncestors(plan.harnessPath);
    await assertNoSymlinkAncestors(plan.backupPath);
    await assertNoSymlinkAncestors(plan.receiptPath);
    await assertNoSymlinkAncestors(join(plan.root, 'versions'));
    await lstat(backup).then(() => fail(`backup already exists: ${backup}`), (error) => { if (error.code !== 'ENOENT') throw error; });
    await lstat(plan.destination).then(() => fail(`version directory already exists: ${plan.destination}`), (error) => { if (error.code !== 'ENOENT') throw error; });
    await mkdir(join(plan.root, 'versions'), { recursive: true });
    const temporary = await mkdtemp(join(join(plan.root, 'versions'), '.agy-install-'));
    await writeExtracted(plan, temporary);
    await stat(join(temporary, relative(plan.destination, plan.entrypoint)));
    await rename(temporary, plan.destination);
    const beforeWrite = await readFile(plan.harnessPath);
    if (!beforeWrite.equals(plan.harness.originalBytes)) fail('harness changed during installation; refusing a configuration conflict');
    await lstat(backup).then(() => fail(`backup already exists: ${backup}`), (error) => { if (error.code !== 'ENOENT') throw error; });
    await lstat(plan.receiptPath).then(() => fail(`receipt already exists: ${plan.receiptPath}`), (error) => { if (error.code !== 'ENOENT') throw error; });
    const stage = await mkdtemp(join(dirname(plan.harnessPath), '.agy-harness-'));
    const stagedHarness = join(stage, 'harness.json');
    const stagedReceipt = join(stage, 'receipt.json');
    await writeFile(stagedHarness, plan.harness.installedBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(stagedReceipt, `${JSON.stringify(plan.receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await beforePublish?.();
    const claim = `${plan.harnessPath}.claim-${randomUUID()}`;
    await assertNoSymlinkAncestors(claim);
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
    try {
      await link(claim, backup);
      await link(stagedReceipt, plan.receiptPath);
      await link(stagedHarness, plan.harnessPath);
    } catch (error) {
      await restoreClaimIfAbsent(claim, plan.harnessPath).catch(() => {});
      throw error;
    }
    await unlink(stagedHarness).catch(() => {});
    await unlink(stagedReceipt).catch(() => {});
    return { action: 'install', applied: true, root: plan.root, harnessPath: plan.harnessPath, destination: plan.destination, entrypoint: plan.entrypoint, backupPath: backup, receiptPath: plan.receiptPath, package: plan.package };
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
  return { action: 'rollback', apply: false, backup: resolve(backup), receiptPath, harness: resolve(harness), originalBytes: previous.bytes, currentBytes: current.bytes, current: current.config, previous: previous.config, receipt };
}

export async function applyRollback(plan, { beforePublish } = {}) {
  if (!plan || plan.action !== 'rollback') fail('invalid rollback plan');
  return withManagerLock(plan.harness, async () => {
    const fresh = await planRollback({ backup: plan.backup, harness: plan.harness });
    if (!fresh.originalBytes.equals(plan.originalBytes) || !fresh.currentBytes.equals(plan.currentBytes)) fail('configuration changed after the rollback plan; refusing a configuration conflict');
    const stage = await mkdtemp(join(dirname(plan.harness), '.agy-rollback-'));
    const staged = join(stage, 'harness.json');
    await writeFile(staged, fresh.originalBytes, { flag: 'wx', mode: 0o600 });
    await beforePublish?.();
    const claim = `${plan.harness}.rollback-current-${randomUUID()}`;
    await assertNoSymlinkAncestors(claim);
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
    await link(staged, plan.harness);
    await unlink(staged).catch(() => {});
    return { action: 'rollback', applied: true, harness: plan.harness, backup: plan.backup, receiptPath: plan.receiptPath, currentBackupPath: claim };
  });
}

export function parseManageArgs(argv) {
  const options = { apply: false, json: false };
  let action;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'install' || arg === 'rollback') {
      if (action) fail('only one action may be selected');
      action = arg;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!['archive', 'sha256', 'root', 'harness', 'backup'].includes(key)) fail(`unknown option: ${arg}`);
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
    '',
    'Without --apply, commands print a verified plan and do not mutate files.'
  ].join('\n');
}

export async function runManageCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseManageArgs(argv);
    if (options.help) { stdout.write(`${manageUsage()}\n`); return 0; }
    const plan = options.action === 'install' ? await planInstall(options) : await planRollback(options);
    if (options.apply) {
      const applied = options.action === 'install' ? await applyInstall(plan) : await applyRollback(plan);
      stdout.write(`${JSON.stringify({ action: applied.action, applied: true, root: applied.root, destination: applied.destination, entrypoint: applied.entrypoint, package: applied.package, harnessPath: applied.harnessPath ?? applied.harness, backupPath: applied.backupPath ?? applied.backup, receiptPath: applied.receiptPath, currentBackupPath: applied.currentBackupPath }, null, 2)}\n`);
    } else {
      stdout.write(`${JSON.stringify({ action: plan.action, apply: false, root: plan.root, destination: plan.destination, entrypoint: plan.entrypoint, package: plan.package, harnessPath: plan.harnessPath ?? plan.harness, backupPath: plan.backupPath, receiptPath: plan.receiptPath, backup: plan.backup }, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`agy-buzz-manage: ${error.message}\n`);
    return 2;
  }
}
