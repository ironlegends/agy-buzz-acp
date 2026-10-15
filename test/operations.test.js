import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const worker = join(repoRoot, 'fixtures', 'manager-interruption-worker.mjs');

function tarEntry(name, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644', 100, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
  header[156] = 0;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(' ', 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function archive() {
  const manifest = JSON.stringify({ name: 'agy-buzz-acp', version: '0.4.0', files: ['bin', 'src', 'docs'] });
  return gzipSync(Buffer.concat([
    tarEntry('package/package.json', manifest),
    tarEntry('package/bin/agy-buzz-acp.js', '#!/usr/bin/env node\n'),
    tarEntry('package/src/manage.js', 'export {};\n'),
    Buffer.alloc(1024)
  ]));
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function harness(entrypoint) {
  return `${JSON.stringify({
    id: 'operations-fixture',
    label: 'Synthetic manager fixture',
    command: process.execPath,
    args: [entrypoint, '--stdio'],
    env: { AGY_COMMAND: 'synthetic', BUZZ_CLI_COMMAND: 'synthetic' }
  }, null, 2)}\n`;
}

async function setupManagerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agy-operations-'));
  const oldEntrypoint = join(root, 'old', 'bin', 'agy-buzz-acp.js');
  const harnessPath = join(root, 'harness.json');
  const archivePath = join(root, 'candidate.tgz');
  await mkdir(dirname(oldEntrypoint), { recursive: true });
  await writeFile(oldEntrypoint, 'old synthetic adapter\n');
  await writeFile(harnessPath, harness(oldEntrypoint));
  const archiveBytes = archive();
  await writeFile(archivePath, archiveBytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, harnessPath, archivePath, archiveBytes, oldEntrypoint };
}

async function setupRollbackFixture(t) {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const original = await readFile(fixture.harnessPath);
  const backupPath = `${fixture.harnessPath}.backup`;
  await writeFile(backupPath, original);
  const installedEntrypoint = join(fixture.root, 'versions', 'agy-buzz-acp-0.4.0', 'bin', 'agy-buzz-acp.js');
  await mkdir(dirname(installedEntrypoint), { recursive: true });
  await writeFile(installedEntrypoint, 'installed synthetic adapter\n');
  const current = JSON.parse(original);
  current.args[0] = installedEntrypoint;
  const currentBytes = Buffer.from(JSON.stringify(current));
  await writeFile(fixture.harnessPath, currentBytes);
  await writeFile(`${backupPath}.receipt.json`, JSON.stringify({
    version: 1,
    harnessPath: fixture.harnessPath,
    backupPath,
    originalDigest: digest(original),
    installedDigest: digest(currentBytes),
    previousEntrypoint: fixture.oldEntrypoint,
    installedEntrypoint
  }));
  const plan = await manage.planRollback({ backup: backupPath, harness: fixture.harnessPath });
  return { ...fixture, plan };
}

async function createJunction(t, target) {
  const parent = await mkdtemp(join(tmpdir(), 'agy-operations-junction-'));
  const link = join(parent, 'runtime-junction');
  t.after(() => rm(parent, { recursive: true, force: true }));
  try { await symlink(target, link, 'junction'); }
  catch (error) {
    if (error?.code === 'EPERM') return null;
    throw error;
  }
  return link;
}

test('the default subprocess deadline permits a slow successful auxiliary check', { timeout: 15_000 }, async () => {
  const { runBoundedSubprocess } = await import('../src/steering.js');
  const { stdout } = await runBoundedSubprocess(process.execPath, [
    '-e', 'setTimeout(() => process.stdout.write("checked"), 2200)'
  ]);
  assert.equal(stdout, 'checked');
});

test('the bounded subprocess helper stops a real synthetic command that never exits', async () => {
  const steering = await import('../src/steering.js');
  assert.equal(typeof steering.runBoundedSubprocess, 'function');
  const started = Date.now();
  await assert.rejects(steering.runBoundedSubprocess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 75,
    maxBuffer: 1024,
    windowsHide: true
  }), (error) => Boolean(error?.code === 'ETIMEDOUT' || error?.signal || /timed out/i.test(error?.message ?? '')));
  assert.ok(Date.now() - started < 2_000, 'the synthetic child must be closed within the helper bound');
});

test('an interrupted install is diagnosed from its exact claim without repairing files', { timeout: 30_000 }, async (t) => {
  const manage = await import('../src/manage.js');
  assert.equal(typeof manage.diagnoseManager, 'function');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  const child = spawn(process.execPath, [worker, fixture.archivePath, digest(fixture.archiveBytes), fixture.root, fixture.harnessPath], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    shell: false,
    windowsHide: true
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'close');
    }
  });
  const claimNotice = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`interruption fixture timeout: ${stderr}`)), 15_000);
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`interruption fixture closed before claim (${code}): ${stderr}`));
    });
  });
  const notice = await claimNotice;
  assert.equal(notice.kind, 'claim');
  assert.equal(notice.claimPath, `${fixture.harnessPath}.claim-${notice.claimPath.split('.claim-').at(-1)}`);
  const beforeHarness = await readFile(fixture.harnessPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const beforeClaim = await readFile(notice.claimPath);
  child.kill();
  await once(child, 'close');

  const journalBytes = await readFile(plan.journalPath);
  const beforeEntries = await readdir(fixture.root);
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  const afterEntries = await readdir(fixture.root);
  assert.equal(report.status, 'interrupted');
  assert.equal(report.journal.phase, 'harness-claimed');
  assert.equal(report.harness.present, false);
  assert.equal(report.claim.path, notice.claimPath);
  assert.equal(report.claim.present, true);
  assert.equal(report.claim.digest, digest(beforeClaim));
  assert.equal(report.claim.associated, true);
  assert.equal(report.recommendation.action, 'manual-inspection');
  assert.deepEqual(afterEntries.sort(), beforeEntries.sort());
  assert.deepEqual(await readFile(plan.journalPath), journalBytes);
  assert.deepEqual(await readFile(notice.claimPath), beforeClaim);
  assert.equal(await readFile(fixture.harnessPath).catch((error) => error.code), 'ENOENT');
  assert.equal(beforeHarness, null);
});

test('a manager digest conflict is indeterminate and never restored by diagnosis', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const conflicting = harness(join(fixture.root, 'conflict', 'bin', 'agy-buzz-acp.js'));
  await writeFile(fixture.harnessPath, conflicting);
  const before = await readFile(fixture.harnessPath);
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.harness.present, true);
  assert.equal(report.harness.associated, false);
  assert.equal(report.recommendation.action, 'manual-inspection');
  assert.match(report.recommendation.reason, /digest|conflict|insufficient/i);
  assert.deepEqual(await readFile(fixture.harnessPath), before);
});

test('a completed install journal is consistent without exposing harness content', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  const applied = await manage.applyInstall(plan);
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(applied.journalPath, plan.journalPath);
  assert.equal(report.status, 'consistent');
  assert.equal(report.journal.phase, 'complete');
  assert.ok(report.journal.phaseHistory.some((entry) => entry.phase === 'harness-claimed'));
  assert.equal(report.harness.associated, true);
  assert.equal(report.backup.associated, true);
  assert.equal(report.receipt.associated, true);
  assert.equal(JSON.stringify(report).includes('AGY_COMMAND'), false);
  assert.equal(JSON.stringify(report).includes('originalBytes'), false);
});

test('a completed rollback journal tolerates only the prior install claim hardlinked to its backup', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const installPlan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(installPlan);
  const rollbackPlan = await manage.planRollback({ backup: installPlan.backupPath, harness: fixture.harnessPath });
  await manage.applyRollback(rollbackPlan);
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(report.status, 'consistent');
  assert.equal(report.journal.action, 'rollback');
  assert.equal(report.journal.phase, 'complete');
  assert.equal(report.claim.associated, true);
  assert.equal(report.backup.associated, true);
  assert.equal(report.receipt.associated, true);
});

test('a readable manager marker remains unresolved even when completed files match', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const lockPath = `${fixture.harnessPath}.agy-lock`;
  await writeFile(lockPath, 'synthetic stale marker\n');
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.lock.present, true);
  assert.match(report.recommendation.reason, /marker|lock/i);
  assert.equal(await readFile(lockPath, 'utf8'), 'synthetic stale marker\n');
});

test('journal path tampering is indeterminate and diagnosis leaves the journal untouched', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const journalBytes = await readFile(plan.journalPath);
  const journal = JSON.parse(journalBytes);
  journal.destination = join(fixture.root, 'unreviewed-destination');
  await writeFile(plan.journalPath, `${JSON.stringify(journal)}\n`);
  const tamperedBytes = await readFile(plan.journalPath);
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(report.status, 'indeterminate');
  assert.match(report.recommendation.reason, /path|association|journal/i);
  assert.deepEqual(await readFile(plan.journalPath), tamperedBytes);
  assert.notDeepEqual(tamperedBytes, journalBytes);
});

test('a completed journal without its recorded claim is insufficient for consistency', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const journal = JSON.parse(await readFile(plan.journalPath, 'utf8'));
  await rm(journal.claimPath, { force: true });
  const report = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.notEqual(report.status, 'consistent');
  assert.equal(report.claim.present, false);
  assert.equal(report.recommendation.action, 'manual-inspection');
});

test('diagnosis refuses a substituted claim instead of following its target', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const journal = JSON.parse(await readFile(plan.journalPath, 'utf8'));
  const claimTarget = `${journal.claimPath}.real`;
  await rename(journal.claimPath, claimTarget);
  try { await symlink(claimTarget, journal.claimPath, 'file'); }
  catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('the current Windows account cannot create file links');
      return;
    }
    throw error;
  }
  const substituted = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(substituted.status, 'indeterminate');
  assert.match(substituted.recommendation.reason, /conflict|claim|journal/i);
});

test('install diagnosis recognizes the claim before and after rename and remains fail-closed', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  const snapshots = {};
  const realRename = fsPromises.rename.bind(fsPromises);
  mock.method(fsPromises, 'rename', async (source, target) => {
    if (source !== fixture.harnessPath || !target.startsWith(`${fixture.harnessPath}.claim-`)) {
      return realRename(source, target);
    }

    const claimingJournalBytes = await readFile(plan.journalPath);
    const readyJournal = JSON.parse(claimingJournalBytes);
    readyJournal.phase = 'ready-to-claim';
    readyJournal.phaseHistory.pop();
    readyJournal.updatedAt = readyJournal.phaseHistory.at(-1).at;
    await writeFile(plan.journalPath, JSON.stringify(readyJournal));
    snapshots.ready = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: plan.journalPath });
    await writeFile(plan.journalPath, claimingJournalBytes);

    snapshots.before = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: plan.journalPath });
    const result = await realRename(source, target);
    snapshots.after = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: plan.journalPath });

    const claimBytes = await readFile(target);
    await writeFile(target, 'different synthetic claim bytes');
    snapshots.wrongDigest = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: plan.journalPath });
    await writeFile(target, claimBytes);

    const journalBytes = await readFile(plan.journalPath);
    const malformed = JSON.parse(journalBytes);
    malformed.claimDigest = 'malformed-digest';
    await writeFile(plan.journalPath, JSON.stringify(malformed));
    snapshots.malformed = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: plan.journalPath });
    await writeFile(plan.journalPath, journalBytes);
    return result;
  });
  syncBuiltinESMExports();
  try { await manage.applyInstall(plan); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }

  assert.equal(snapshots.ready.journal.valid, true);
  assert.equal(snapshots.ready.journal.phase, 'ready-to-claim');
  assert.equal(snapshots.ready.journal.claimDigest, null);
  assert.equal(snapshots.ready.harness.associated, true);
  assert.equal(snapshots.ready.claim.present, false);

  assert.equal(snapshots.before.journal.valid, true);
  assert.equal(snapshots.before.journal.phase, 'claiming-harness');
  assert.equal(snapshots.before.journal.claimDigest, null);
  assert.equal(snapshots.before.harness.associated, true);
  assert.equal(snapshots.before.claim.present, false);

  assert.equal(snapshots.after.journal.valid, true);
  assert.equal(snapshots.after.journal.phase, 'claiming-harness');
  assert.equal(snapshots.after.claim.expectedDigest, snapshots.after.journal.expectedHarnessDigest);
  assert.equal(snapshots.after.claim.associated, true);
  assert.equal(snapshots.after.status, 'interrupted');

  assert.equal(snapshots.wrongDigest.journal.valid, true);
  assert.equal(snapshots.wrongDigest.claim.associated, false);
  assert.equal(snapshots.wrongDigest.status, 'indeterminate');
  assert.equal(snapshots.malformed.journal.valid, false);
  assert.equal(snapshots.malformed.journal.reason, 'invalid');
  assert.equal(snapshots.malformed.status, 'indeterminate');
});

test('rollback diagnosis recognizes the current-harness claim before and after rename', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupRollbackFixture(t);
  const journalPath = `${fixture.harnessPath}.agy-journal.json`;
  const snapshots = {};
  const realRename = fsPromises.rename.bind(fsPromises);
  mock.method(fsPromises, 'rename', async (source, target) => {
    if (source !== fixture.harnessPath || !target.startsWith(`${fixture.harnessPath}.rollback-current-`)) {
      return realRename(source, target);
    }

    const claimingJournalBytes = await readFile(journalPath);
    const readyJournal = JSON.parse(claimingJournalBytes);
    readyJournal.phase = 'ready-to-claim';
    readyJournal.phaseHistory.pop();
    readyJournal.updatedAt = readyJournal.phaseHistory.at(-1).at;
    await writeFile(journalPath, JSON.stringify(readyJournal));
    snapshots.ready = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: journalPath });
    await writeFile(journalPath, claimingJournalBytes);

    snapshots.before = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: journalPath });
    const result = await realRename(source, target);
    snapshots.after = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: journalPath });

    const claimBytes = await readFile(target);
    await writeFile(target, 'different synthetic rollback claim bytes');
    snapshots.wrongDigest = await manage.diagnoseManager({ harness: fixture.harnessPath, journal: journalPath });
    await writeFile(target, claimBytes);
    return result;
  });
  syncBuiltinESMExports();
  try { await manage.applyRollback(fixture.plan); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }

  assert.equal(snapshots.ready.journal.valid, true);
  assert.equal(snapshots.ready.journal.phase, 'ready-to-claim');
  assert.equal(snapshots.ready.journal.claimDigest, null);
  assert.equal(snapshots.ready.harness.associated, true);
  assert.equal(snapshots.ready.claim.present, false);

  assert.equal(snapshots.before.journal.valid, true);
  assert.equal(snapshots.before.journal.action, 'rollback');
  assert.equal(snapshots.before.journal.phase, 'claiming-current-harness');
  assert.equal(snapshots.before.journal.claimDigest, null);
  assert.equal(snapshots.before.harness.associated, true);
  assert.equal(snapshots.before.claim.present, false);

  assert.equal(snapshots.after.journal.valid, true);
  assert.equal(snapshots.after.journal.phase, 'claiming-current-harness');
  assert.equal(snapshots.after.claim.expectedDigest, snapshots.after.journal.expectedHarnessDigest);
  assert.equal(snapshots.after.claim.associated, true);
  assert.equal(snapshots.after.status, 'interrupted');
  assert.equal(snapshots.wrongDigest.journal.valid, true);
  assert.equal(snapshots.wrongDigest.claim.associated, false);
  assert.equal(snapshots.wrongDigest.status, 'indeterminate');
});

test('diagnosis rejects invalid UTF-8 journals without exposing replacement text', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const journalPath = `${fixture.harnessPath}.agy-journal.json`;
  await writeFile(journalPath, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
  const invalidUtf8 = await manage.diagnoseManager({ harness: fixture.harnessPath });
  assert.equal(invalidUtf8.status, 'indeterminate');
  assert.equal(invalidUtf8.journal.reason, 'invalid-utf8');
  assert.equal(JSON.stringify(invalidUtf8).includes('\ufffd'), false);
});

test('a new manager operation does not overwrite an incomplete journal', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const plan = await manage.planInstall({
    archive: fixture.archivePath,
    sha256: digest(fixture.archiveBytes),
    root: fixture.root,
    harness: fixture.harnessPath
  });
  await manage.applyInstall(plan);
  const journal = JSON.parse(await readFile(plan.journalPath, 'utf8'));
  journal.phase = 'harness-staged';
  journal.phaseHistory = journal.phaseHistory.filter((entry) => entry.phase !== 'complete');
  journal.claimPath = null;
  journal.claimDigest = null;
  const incompleteBytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  await writeFile(plan.journalPath, incompleteBytes);
  await assert.rejects(manage.applyInstall(plan), /incomplete|ambiguous|journal/i);
  assert.deepEqual(await readFile(plan.journalPath), incompleteBytes);
});

test('the manager diagnose CLI is read-only and does not print harness environment values', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const cli = join(repoRoot, 'bin', 'agy-buzz-manage.js');
  const result = spawnSync(process.execPath, [cli, 'diagnose', '--harness', fixture.harnessPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'insufficient-evidence');
  assert.equal(result.stdout.includes('synthetic'), false);
  assert.equal(result.stdout.includes('originalBytes'), false);
  assert.equal(typeof manage.parseManageArgs(['diagnose', '--harness', fixture.harnessPath]).action, 'string');
});

test('an unsafe harness parent returns an indeterminate report before reading target or claims', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const junction = await createJunction(t, fixture.root);
  if (!junction) {
    t.skip('the current Windows account cannot create junctions');
    return;
  }
  await writeFile(join(fixture.root, 'harness.json.claim-ignored'), 'synthetic claim evidence\n');
  const report = await manage.diagnoseManager({ harness: join(junction, 'harness.json') });
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.automaticRecovery, false);
  assert.equal(report.unsafePath.kind, 'harness');
  assert.equal(report.unsafePath.reason, 'unsafe-path');
  assert.deepEqual(report.claims, []);
  assert.equal(Object.hasOwn(report, 'harness'), false);
});

test('an unsafe journal parent returns an indeterminate report before reading target or claims', async (t) => {
  const manage = await import('../src/manage.js');
  const fixture = await setupManagerFixture(t);
  const junction = await createJunction(t, fixture.root);
  if (!junction) {
    t.skip('the current Windows account cannot create junctions');
    return;
  }
  await writeFile(join(fixture.root, 'harness.json.claim-ignored'), 'synthetic claim evidence\n');
  const report = await manage.diagnoseManager({
    harness: fixture.harnessPath,
    journal: join(junction, 'harness.json.agy-journal.json')
  });
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.automaticRecovery, false);
  assert.equal(report.unsafePath.kind, 'journal');
  assert.equal(report.unsafePath.reason, 'unsafe-path');
  assert.deepEqual(report.claims, []);
  assert.equal(Object.hasOwn(report, 'harness'), false);
});

test('the operations documentation records conservative manager and outbox compatibility contracts', async () => {
  const managerDoc = await readFile(join(repoRoot, 'docs', 'MANAGER_RECOVERY.md'), 'utf8');
  const outboxDoc = await readFile(join(repoRoot, 'docs', 'OUTBOX_COMPATIBILITY.md'), 'utf8');
  assert.match(managerDoc, /journal/i);
  assert.match(managerDoc, /lecture seule|read-only/i);
  assert.match(managerDoc, /ne permet|does not|jamais|never/i);
  assert.match(outboxDoc, /relay|relais/i);
  assert.match(outboxDoc, /channelId/);
  assert.match(outboxDoc, /replyTo/);
  assert.match(outboxDoc, /uncertain/);
  assert.match(outboxDoc, /inflight/);
  assert.match(outboxDoc, /migration|migration future/i);
  assert.match(outboxDoc, /separ|sépar/);
});
