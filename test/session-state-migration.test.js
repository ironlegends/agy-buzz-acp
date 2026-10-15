import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireNativeLock } from '../src/native-lock.js';
import { SessionState } from '../src/session-state.js';

const owner = 'ab'.repeat(32);
const relay = 'wss://relay.example.test/migration';
const lowerChannel = '123e4567-e89b-12d3-a456-426614174000';
const upperChannel = lowerChannel.toUpperCase();

function legacyHash(channelId) {
  return createHash('sha256').update(channelId).digest('hex');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agy-session-migration-'));
  const sourceDir = join(root, 'legacy');
  const destinationDir = join(root, 'canonical');
  await mkdir(sourceDir, { mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, sourceDir, destinationDir };
}

async function addLegacyRecord(sourceDir, channelId, { status = 'ready', conversationId = 'conversation-1' } = {}) {
  const state = new SessionState({ dir: sourceDir, owner, relay });
  const record = {
    schemaVersion: 1,
    sessionScope: 'channel',
    status,
    scope: { owner, relay: state.relay, cwd: sourceDir, model: 'gemini-3.8-flash-high', channelId },
    conversationId: status === 'blocked' ? null : conversationId,
    updatedAt: '2026-10-15T12:00:00.000Z'
  };
  const digest = legacyHash(channelId);
  await writeFile(join(sourceDir, `${digest}.json`), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  const lock = await acquireNativeLock(join(sourceDir, `.${digest}.lock`));
  await lock.release();
  return record;
}

async function sourceSnapshot(sourceDir) {
  const names = (await readdir(sourceDir)).sort();
  const contents = {};
  for (const name of names) contents[name] = (await readFile(join(sourceDir, name))).toString('base64');
  return { names, contents };
}

async function loadMigration() {
  return import('../src/session-state-migration.js');
}

test('dry-run and apply preserve the legacy source while canonicalizing records into an absent destination', async (t) => {
  const { sourceDir, destinationDir } = await fixture(t);
  await addLegacyRecord(sourceDir, upperChannel);
  await addLegacyRecord(sourceDir, '223e4567-e89b-12d3-a456-426614174000', { status: 'blocked' });
  const before = await sourceSnapshot(sourceDir);
  const { migrateLegacySessionState } = await loadMigration();

  const dryRun = await migrateLegacySessionState({ sourceDir, destinationDir, owner, relay });
  assert.deepEqual(dryRun, { applied: false, recordCount: 2, blockedCount: 1 });
  await assert.rejects(lstat(destinationDir), { code: 'ENOENT' });
  assert.deepEqual(await sourceSnapshot(sourceDir), before);

  const applied = await migrateLegacySessionState({ sourceDir, destinationDir, owner, relay, apply: true });
  assert.deepEqual(applied, { applied: true, recordCount: 2, blockedCount: 1 });
  assert.deepEqual(await sourceSnapshot(sourceDir), before);
  const migratedReady = JSON.parse(await readFile(join(destinationDir, `${legacyHash(lowerChannel)}.json`), 'utf8'));
  const migratedBlocked = JSON.parse(await readFile(join(destinationDir, `${legacyHash('223e4567-e89b-12d3-a456-426614174000')}.json`), 'utf8'));
  assert.equal(migratedReady.scope.channelId, lowerChannel);
  assert.equal(migratedReady.status, 'ready');
  assert.equal(migratedBlocked.status, 'blocked');

  const state = new SessionState({ dir: destinationDir, owner, relay });
  try {
    const scope = await state.scope({ channelId: lowerChannel, cwd: sourceDir, model: 'gemini-3.8-flash-high' });
    assert.equal((await state.load(scope)).conversationId, 'conversation-1');
    const blockedScope = await state.scope({ channelId: '223e4567-e89b-12d3-a456-426614174000', cwd: sourceDir, model: 'gemini-3.8-flash-high' });
    await assert.rejects(state.load(blockedScope), /blocked after an incomplete turn/);
  } finally { await state.release(); }
});

test('migration refuses case-folding collisions and leaves source and destination unchanged', async (t) => {
  const { sourceDir, destinationDir } = await fixture(t);
  await addLegacyRecord(sourceDir, lowerChannel);
  await addLegacyRecord(sourceDir, upperChannel);
  const before = await sourceSnapshot(sourceDir);
  const { migrateLegacySessionState } = await loadMigration();
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay, apply: true }),
    (error) => error.code === 'AGY_STATE_MIGRATION_COLLISION');
  assert.deepEqual(await sourceSnapshot(sourceDir), before);
  await assert.rejects(lstat(destinationDir), { code: 'ENOENT' });
});

test('migration refuses unknown files and opaque locks without changing source', async (t) => {
  const { sourceDir, destinationDir } = await fixture(t);
  await addLegacyRecord(sourceDir, lowerChannel);
  await writeFile(join(sourceDir, 'notes.txt'), 'not migration input');
  const before = await sourceSnapshot(sourceDir);
  const { migrateLegacySessionState } = await loadMigration();
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_UNKNOWN_FILE');
  assert.deepEqual(await sourceSnapshot(sourceDir), before);
  await rm(join(sourceDir, 'notes.txt'));
  await writeFile(join(sourceDir, `.${'f'.repeat(64)}.lock`), '');
  const withOpaqueLock = await sourceSnapshot(sourceDir);
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_OPAQUE_LOCK');
  assert.deepEqual(await sourceSnapshot(sourceDir), withOpaqueLock);
});

test('migration refuses held or missing source locks without creating replacements', async (t) => {
  const { sourceDir, destinationDir } = await fixture(t);
  await addLegacyRecord(sourceDir, lowerChannel);
  const lockPath = join(sourceDir, `.${legacyHash(lowerChannel)}.lock`);
  const held = await acquireNativeLock(lockPath);
  const { migrateLegacySessionState } = await loadMigration();
  try {
    await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
      (error) => error.code === 'AGY_STATE_MIGRATION_LOCKED');
  } finally { await held.release(); }
  await rm(lockPath);
  const before = await sourceSnapshot(sourceDir);
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_MISSING_LOCK');
  assert.deepEqual(await sourceSnapshot(sourceDir), before);
});

test('migration refuses hard-linked source records and existing destinations', async (t) => {
  const { sourceDir, destinationDir, root } = await fixture(t);
  await addLegacyRecord(sourceDir, lowerChannel);
  const recordPath = join(sourceDir, `${legacyHash(lowerChannel)}.json`);
  await link(recordPath, join(root, 'outside-link.json'));
  const { migrateLegacySessionState } = await loadMigration();
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_UNSAFE_FILE');
  await rm(join(root, 'outside-link.json'));
  await mkdir(destinationDir, { mode: 0o700 });
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_DESTINATION_EXISTS');
});

test('migration refuses linked source and destination ancestors', async (t) => {
  const { sourceDir, destinationDir, root } = await fixture(t);
  await addLegacyRecord(sourceDir, lowerChannel);
  const { migrateLegacySessionState } = await loadMigration();
  const sourceLink = join(root, 'source-link');
  await symlink(sourceDir, sourceLink, 'junction');
  await assert.rejects(migrateLegacySessionState({ sourceDir: sourceLink, destinationDir, owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_UNSAFE_PATH');
  await rm(sourceLink);
  const linkedParent = join(root, 'destination-parent-link');
  await symlink(root, linkedParent, 'junction');
  await assert.rejects(migrateLegacySessionState({ sourceDir, destinationDir: join(linkedParent, 'target'), owner, relay }),
    (error) => error.code === 'AGY_STATE_MIGRATION_UNSAFE_PATH');
});
