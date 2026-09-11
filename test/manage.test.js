import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyInstall,
  applyRollback,
  parseManageArgs,
  planInstall,
  planRollback
} from '../src/manage.js';

function tarEntry(name, content, type = '0') {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(type === '5' ? '0000755' : '0000644', 100, 8, 'ascii');
  header.write('0000000', 108, 8, 'ascii');
  header.write('0000000', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
  header.write('00000000000 ', 136, 12, 'ascii');
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  header.fill(' ', 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function archive(entries) {
  return gzipSync(Buffer.concat([...entries.map(({ name, content, type }) => tarEntry(name, content, type)), Buffer.alloc(1024)]));
}

function validArchive(extra = []) {
  const manifest = JSON.stringify({ name: 'agy-buzz-acp', version: '0.4.0', files: ['bin', 'src', 'docs'] });
  return archive([
    { name: 'package/package.json', content: manifest },
    { name: 'package/bin/agy-buzz-acp.js', content: '#!/usr/bin/env node\n' },
    { name: 'package/src/manage.js', content: 'export {};\n' },
    ...extra
  ]);
}

function bundledArchive(extra = [], bundledDependencies = ['fs-native-extensions']) {
  const manifest = JSON.stringify({ name: 'agy-buzz-acp', version: '0.4.0', files: ['bin', 'src', 'docs'], bundledDependencies });
  return archive([
    { name: 'package/package.json', content: manifest },
    { name: 'package/bin/agy-buzz-acp.js', content: '#!/usr/bin/env node\n' },
    { name: 'package/src/manage.js', content: 'export {};\n' },
    ...extra
  ]);
}

function harness(entrypoint, overrides = {}) {
  return JSON.stringify({
    id: 'keep-id',
    label: 'Keep label',
    command: process.execPath,
    args: [entrypoint, '--stdio'],
    env: { AGY_COMMAND: 'agy', BUZZ_CLI_COMMAND: 'buzz' },
    ...overrides
  }, null, 2) + '\n';
}

async function setupHarness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-manage-')));
  const oldEntry = join(root, 'old', 'bin', 'agy-buzz-acp.js');
  await mkdir(join(root, 'old', 'bin'), { recursive: true });
  await writeFile(oldEntry, 'old adapter\n', 'utf8');
  const harnessPath = join(root, 'harness.json');
  await writeFile(harnessPath, harness(oldEntry), 'utf8');
  return { root, oldEntry, harnessPath };
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('plans a verified install without mutating the harness or runtime root', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const before = await readFile(harnessPath);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  assert.equal(plan.package.name, 'agy-buzz-acp');
  assert.equal(plan.package.version, '0.4.0');
  assert.equal(plan.apply, false);
  assert.deepEqual(plan.harness.after.id, 'keep-id');
  assert.deepEqual(plan.harness.after.label, 'Keep label');
  assert.deepEqual(plan.harness.after.command, process.execPath);
  assert.deepEqual(plan.harness.after.env, { AGY_COMMAND: 'agy', BUZZ_CLI_COMMAND: 'buzz' });
  assert.equal((await readFile(harnessPath)).equals(before), true);
  await assert.rejects(stat(join(root, 'versions')), /ENOENT/);
});

test('accepts files belonging to an explicitly bundled dependency', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = bundledArchive([
    { name: 'package/node_modules/fs-native-extensions/LICENSE', content: 'Apache-2.0\n' },
    { name: 'package/node_modules/fs-native-extensions/prebuilds/win32-x64/fs-native-extensions.node', content: 'native\n' }
  ]);
  const archivePath = join(root, 'bundled.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  assert.ok(plan.package.files.includes('node_modules/fs-native-extensions/LICENSE'));
});

test('rejects a package file under node_modules when that package is not explicitly bundled', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = bundledArchive([{ name: 'package/node_modules/require-addon/index.js', content: 'export {};\n' }]);
  const archivePath = join(root, 'undeclared-bundle.tgz');
  await writeFile(archivePath, tgz);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /bundled|node_modules|listed/i);
});

test('rejects traversal inside a bundled dependency path', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = bundledArchive([{ name: 'package/node_modules/fs-native-extensions/../../outside.js', content: 'escape' }]);
  const archivePath = join(root, 'bundled-traversal.tgz');
  await writeFile(archivePath, tgz);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /path|traversal/i);
});

test('rejects an archive whose digest does not match before parsing or extraction', async () => {
  const { root, harnessPath } = await setupHarness();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, validArchive());
  await assert.rejects(
    planInstall({ archive: archivePath, sha256: '0'.repeat(64), root, harness: harnessPath }),
    /sha256/i
  );
});

test('rejects traversal entries before extraction', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive([{ name: 'package/../../outside.txt', content: 'escape' }]);
  const archivePath = join(root, 'evil.tgz');
  await writeFile(archivePath, tgz);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /path|traversal/i);
  await assert.rejects(stat(join(root, 'outside.txt')), /ENOENT/);
});

test('rejects symlink and hardlink archive entries', async () => {
  const { root, harnessPath } = await setupHarness();
  for (const type of ['1', '2']) {
    const tgz = validArchive([{ name: `package/link-${type}`, content: '', type }]);
    const archivePath = join(root, `link-${type}.tgz`);
    await writeFile(archivePath, tgz);
    await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /link|unsupported|regular/i);
  }
});

test('rejects case-colliding archive paths and Windows unsafe names', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive([
    { name: 'package/src/Manage.js', content: 'one' },
    { name: 'package/src/manage.js', content: 'two' }
  ]);
  const archivePath = join(root, 'collision.tgz');
  await writeFile(archivePath, tgz);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /duplicate|collid/i);
  const unsafe = validArchive([{ name: 'package/CON.txt', content: 'reserved' }]);
  await writeFile(archivePath, unsafe);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(unsafe), root, harness: harnessPath }), /unsafe|Windows/i);
});

test('rejects a harness whose first argument is not the adapter entrypoint', async () => {
  const { root, harnessPath } = await setupHarness();
  await writeFile(harnessPath, harness(join(root, 'other-command.js')), 'utf8');
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  await assert.rejects(planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath }), /entrypoint|adapter/i);
});

test('apply writes a backup and changes only the adapter entrypoint', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  const applied = await applyInstall(plan);
  assert.match(applied.backupPath, new RegExp(`${harnessPath.replaceAll('\\', '\\\\')}\\.\\d+-[0-9a-f-]+\\.backup$`));
  assert.equal((await stat(applied.receiptPath)).isFile(), true);
  const original = JSON.parse(await readFile(applied.backupPath, 'utf8'));
  const current = JSON.parse(await readFile(harnessPath, 'utf8'));
  assert.equal(original.args[0], join(root, 'old', 'bin', 'agy-buzz-acp.js'));
  assert.equal(current.id, original.id);
  assert.equal(current.label, original.label);
  assert.equal(current.command, original.command);
  assert.deepEqual(current.env, original.env);
  assert.deepEqual(current.args.slice(1), original.args.slice(1));
  assert.match(current.args[0], /versions[\\/]agy-buzz-acp-0\.4\.0[\\/]bin[\\/]agy-buzz-acp\.js$/);
  assert.equal((await stat(current.args[0])).isFile(), true);
});

test('apply refuses a harness changed after planning', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  await writeFile(harnessPath, harness(join(root, 'other', 'agy-buzz-acp.js')), 'utf8');
  await assert.rejects(applyInstall(plan), /changed|conflict/i);
  await assert.rejects(stat(`${harnessPath}.backup`), /ENOENT/);
});

test('install preserves a concurrent final-window writer without clobbering it', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  const competing = harness(join(root, 'competing', 'bin', 'agy-buzz-acp.js'));
  await assert.rejects(applyInstall(plan, { beforePublish: () => writeFile(harnessPath, competing) }), /conflict|changed|concurrent/i);
  assert.equal((await readFile(harnessPath, 'utf8')), competing);
  await assert.rejects(stat(plan.backupPath), /ENOENT/);
});

test('install preserves the original when a late backup collision occurs', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  const collision = Buffer.from('unrelated backup\n');
  await assert.rejects(applyInstall(plan, { beforePublish: () => writeFile(plan.backupPath, collision, { flag: 'wx' }) }), /EEXIST|backup|collision|destination/i);
  assert.equal((await readFile(harnessPath)).equals(plan.harness.originalBytes), true);
  assert.equal((await readFile(plan.backupPath)).equals(collision), true);
});

test('install preserves the original when a late receipt collision occurs', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  const plan = await planInstall({ archive: archivePath, sha256: digest(tgz), root, harness: harnessPath });
  const collision = Buffer.from('unrelated receipt\n');
  await assert.rejects(applyInstall(plan, { beforePublish: async () => {
    await writeFile(plan.receiptPath, collision, { flag: 'wx' });
  }}), /EEXIST|receipt|collision|destination/i);
  assert.equal((await readFile(harnessPath)).equals(plan.harness.originalBytes), true);
  assert.equal((await readFile(plan.receiptPath)).equals(collision), true);
});

test('rollback validates identity and restores exact backup bytes', async () => {
  const { root, oldEntry, harnessPath } = await setupHarness();
  const original = await readFile(harnessPath);
  const backupPath = `${harnessPath}.backup`;
  await writeFile(backupPath, original);
  const current = JSON.parse(original);
  current.args[0] = join(root, 'versions', 'agy-buzz-acp-0.4.0', 'bin', 'agy-buzz-acp.js');
  await mkdir(join(root, 'versions', 'agy-buzz-acp-0.4.0', 'bin'), { recursive: true });
  await writeFile(current.args[0], 'installed adapter\n', 'utf8');
  const currentBytes = Buffer.from(JSON.stringify(current));
  await writeFile(harnessPath, currentBytes);
  await writeFile(`${backupPath}.receipt.json`, JSON.stringify({
    version: 1, harnessPath, backupPath, originalDigest: digest(original), installedDigest: digest(currentBytes),
    previousEntrypoint: oldEntry, installedEntrypoint: current.args[0]
  }));
  const plan = await planRollback({ backup: backupPath, harness: harnessPath });
  await applyRollback(plan);
  assert.equal((await readFile(harnessPath)).equals(original), true);
  assert.equal((await stat(oldEntry)).isFile(), true);
});

test('rollback refuses a changed harness identity and preserves both files', async () => {
  const { root, harnessPath } = await setupHarness();
  const original = await readFile(harnessPath);
  const backupPath = `${harnessPath}.backup`;
  await writeFile(backupPath, original);
  const current = JSON.parse(original);
  current.id = 'someone-else';
  const currentBytes = Buffer.from(JSON.stringify(current));
  await writeFile(harnessPath, currentBytes);
  await writeFile(`${backupPath}.receipt.json`, JSON.stringify({
    version: 1, harnessPath, backupPath, originalDigest: digest(original), installedDigest: digest(currentBytes),
    previousEntrypoint: join(root, 'old', 'bin', 'agy-buzz-acp.js'), installedEntrypoint: current.args[0]
  }));
  await assert.rejects(planRollback({ backup: backupPath, harness: harnessPath }), /identity|association|conflict/i);
  assert.equal((await readFile(backupPath)).equals(original), true);
  assert.equal(JSON.parse(await readFile(harnessPath, 'utf8')).id, 'someone-else');
});

test('rollback preserves a concurrent final-window writer without clobbering it', async () => {
  const { root, harnessPath } = await setupHarness();
  const original = await readFile(harnessPath);
  const backupPath = `${harnessPath}.backup`;
  await writeFile(backupPath, original);
  const current = JSON.parse(original);
  current.args[0] = join(root, 'versions', 'agy-buzz-acp-0.4.0', 'bin', 'agy-buzz-acp.js');
  await mkdir(join(root, 'versions', 'agy-buzz-acp-0.4.0', 'bin'), { recursive: true });
  await writeFile(current.args[0], 'installed adapter\n', 'utf8');
  const currentBytes = Buffer.from(JSON.stringify(current));
  await writeFile(harnessPath, currentBytes);
  await writeFile(`${backupPath}.receipt.json`, JSON.stringify({
    version: 1, harnessPath, backupPath, originalDigest: digest(original), installedDigest: digest(currentBytes),
    previousEntrypoint: join(root, 'old', 'bin', 'agy-buzz-acp.js'), installedEntrypoint: current.args[0]
  }));
  const plan = await planRollback({ backup: backupPath, harness: harnessPath });
  const competing = harness(join(root, 'competing', 'bin', 'agy-buzz-acp.js'));
  await assert.rejects(applyRollback(plan, { beforePublish: () => writeFile(harnessPath, competing) }), /conflict|changed|concurrent/i);
  assert.equal((await readFile(harnessPath, 'utf8')), competing);
});

test('management CLI defaults to a read-only plan and requires apply for mutation', async () => {
  const { root, harnessPath } = await setupHarness();
  const tgz = validArchive();
  const archivePath = join(root, 'agy.tgz');
  await writeFile(archivePath, tgz);
  assert.deepEqual(parseManageArgs(['install', '--archive', archivePath, '--sha256', digest(tgz), '--root', root, '--harness', harnessPath]), {
    action: 'install', apply: false, json: false, archive: archivePath, sha256: digest(tgz), root, harness: harnessPath
  });
  const entry = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'agy-buzz-manage.js');
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const plan = spawnSync(process.execPath, [entry, 'install', '--archive', archivePath, '--sha256', digest(tgz), '--root', root, '--harness', harnessPath], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.stdout.includes('"env"'), false);
  assert.equal(plan.stdout.includes('originalBytes'), false);
  assert.equal(plan.stdout.includes('"command"'), false);
});
