import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireNativeLock } from '../src/native-lock.js';
import {
  DeliveryOutbox,
  OUTBOX_STORE_MARKER,
  createConfiguredOutbox,
  outboxRelayFingerprint,
  validateOutboxRecord,
  validateOutboxStoreMarker
} from '../src/delivery/outbox.js';

const owner = 'ab'.repeat(32);
const channelId = '11111111-1111-4111-8111-111111111111';
const replyTo = 'cd'.repeat(32);
const eventId = 'ef'.repeat(32);
const relay = 'wss://relay.example.invalid/acp';
const stamp = '2026-09-11T00:00:00.000Z';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-outbox-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function v1Record(id, status = 'sent', extra = {}) {
  return {
    recoveryId: id, owner, channelId, replyTo, content: 'body for ' + id,
    status, createdAt: stamp, updatedAt: stamp,
    ...(status === 'sent' ? { eventId } : {}),
    ...extra
  };
}

async function writeV1(dir, record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  await writeFile(join(dir, record.recoveryId + '.json'), bytes);
  return bytes;
}

test('bound writes use schema v2 and bind to a canonical relay fingerprint without persisting its URL', async (t) => {
  const dir = await tempDir(t);
  const box = new DeliveryOutbox({
    dir, owner,
    relay: 'HTTPS://Relay.Example.Invalid/acp/?tenant=west#discarded',
    idFn: () => 'bound-record'
  });

  await box.begin({ channelId, replyTo, content: 'synthetic response' });
  const recordBytes = await readFile(box.path('bound-record'));
  const markerBytes = await readFile(join(dir, '.agy-outbox-store'));
  const record = JSON.parse(recordBytes);
  const marker = JSON.parse(markerBytes);
  const expectedFingerprint = createHash('sha256')
    .update('https://relay.example.invalid/acp?tenant=west')
    .digest('hex');

  assert.equal(record.schemaVersion, 2);
  assert.equal(record.relayFingerprint, expectedFingerprint);
  assert.equal(validateOutboxRecord(record), true);
  const { relayFingerprint, ...missingRelay } = record;
  assert.equal(validateOutboxRecord(missingRelay), false);
  assert.equal(validateOutboxRecord({ ...record, unexpected: true }), false);
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.owner, owner);
  assert.equal(marker.relayFingerprint, expectedFingerprint);
  assert.equal(recordBytes.toString('utf8').includes('https://'), false);
  assert.equal(markerBytes.toString('utf8').includes('https://'), false);

  const equivalent = new DeliveryOutbox({ dir, owner, relay: 'https://relay.example.invalid/acp?tenant=west' });
  assert.equal((await equivalent.get('bound-record')).relayFingerprint, expectedFingerprint);
});

test('exported store and relay helpers validate metadata without filesystem effects', () => {
  const fingerprint = outboxRelayFingerprint('HTTPS://Relay.Example.Invalid/acp/?tenant=west#discarded');
  const marker = { schemaVersion: 2, owner, relayFingerprint: fingerprint };

  assert.equal(OUTBOX_STORE_MARKER, '.agy-outbox-store');
  assert.equal(fingerprint, createHash('sha256').update('https://relay.example.invalid/acp?tenant=west').digest('hex'));
  assert.equal(validateOutboxStoreMarker(marker), true);
  assert.equal(validateOutboxStoreMarker(marker, { owner, relayFingerprint: fingerprint }), true);
  assert.equal(validateOutboxStoreMarker(marker, { owner: '12'.repeat(32), relayFingerprint: fingerprint }), false);
  assert.equal(validateOutboxStoreMarker(marker, { owner, relayFingerprint: '34'.repeat(32) }), false);
  assert.equal(validateOutboxStoreMarker({ ...marker, unexpected: true }), false);
  assert.equal(outboxRelayFingerprint('https://user:secret@relay.example.invalid/acp'), null);
});

test('configured outboxes require BUZZ_RELAY_URL while the direct legacy constructor remains read-only', async (t) => {
  const dir = await tempDir(t);
  const record = v1Record('legacy');
  const originalBytes = await writeV1(dir, record);
  const legacy = new DeliveryOutbox({ dir, owner });

  assert.match(createConfiguredOutbox({ AGY_OUTBOX_DIR: dir, AGY_OUTBOX_OWNER: owner }).configurationError, /BUZZ_RELAY_URL/);
  assert.deepEqual(await legacy.get('legacy'), record);
  assert.deepEqual(await legacy.list(), [record]);
  await assert.rejects(
    legacy.update('legacy', { status: 'uncertain' }),
    (error) => error.code === 'AGY_OUTBOX_READ_ONLY'
  );
  assert.deepEqual(await legacy.retry('legacy', { owner, publish: async () => ({ status: 'sent', eventId }) }),
    { status: 'blocked', reason: 'relay-required' });

  let publishCalls = 0;
  const configured = new DeliveryOutbox({ dir, owner, relay });
  assert.deepEqual(await configured.retry('legacy', {
    owner,
    publish: async () => { publishCalls += 1; return { status: 'sent', eventId }; }
  }), { status: 'blocked', reason: 'legacy-unbound' });
  await assert.rejects(
    configured.begin({ channelId, replyTo, content: 'must not promote legacy storage' }),
    (error) => error.code === 'AGY_OUTBOX_LEGACY_READ_ONLY'
  );
  assert.equal(publishCalls, 0);
  assert.deepEqual(await readFile(join(dir, 'legacy.json')), originalBytes);
  assert.equal((await readdir(dir)).includes('.agy-outbox-store'), false);
});

test('relay URLs with embedded credentials are rejected without echoing secrets', () => {
  const outbox = new DeliveryOutbox({
    dir: 'C:/private/outbox',
    owner,
    relay: 'https://user:secret@relay.example.invalid/acp'
  });

  assert.match(outbox.configurationError, /BUZZ_RELAY_URL/);
  assert.equal(outbox.configurationError.includes('secret'), false);
  assert.equal(outbox.enabled, false);
});

test('a marked store rejects account or relay changes before reading or writing records', async (t) => {
  const dir = await tempDir(t);
  const original = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'bound-record' });
  await original.begin({ channelId, replyTo, content: 'synthetic response' });

  const wrongOwner = new DeliveryOutbox({ dir, owner: '12'.repeat(32), relay });
  const wrongRelay = new DeliveryOutbox({ dir, owner, relay: 'wss://other-relay.example.invalid/acp' });
  await assert.rejects(wrongOwner.get('bound-record'), (error) => error.code === 'AGY_OUTBOX_STORE_MISMATCH');
  await assert.rejects(wrongRelay.begin({ channelId, replyTo, content: 'must not write' }),
    (error) => error.code === 'AGY_OUTBOX_STORE_MISMATCH');
  assert.equal((await original.get('bound-record')).content, 'synthetic response');
});

test('unsettled scanning passes 1000 sent records, finds a later unresolved record, and rejects a later corrupt record', async (t) => {
  const dir = await tempDir(t);
  for (let index = 0; index < 1001; index += 1) {
    await writeV1(dir, v1Record('sent-' + String(index).padStart(4, '0')));
  }
  const later = v1Record('zz-later', 'failed-before-start');
  await writeV1(dir, later);
  const box = new DeliveryOutbox({ dir, owner });

  assert.equal(await box.hasUnsettledDelivery(channelId), true);

  await writeV1(dir, v1Record('zz-later'));
  await writeFile(join(dir, 'zz-invalid.json'), '{"recoveryId":"zz-invalid","status":"broken"}\n');
  await assert.rejects(box.hasUnsettledDelivery(channelId), (error) => error.code === 'AGY_OUTBOX_CORRUPT');
});

test('every non-sent delivery status blocks its channel regardless of UUID casing', async (t) => {
  for (const status of ['inflight', 'uncertain', 'failed-before-start']) {
    const dir = await tempDir(t);
    await writeV1(dir, v1Record('active-' + status, status));
    const box = new DeliveryOutbox({ dir, owner });

    assert.equal(await box.hasUnsettledDelivery(channelId.toUpperCase()), true);
  }
});

test('a recovery record disappearing during a complete unsettled scan fails closed', async (t) => {
  const dir = await tempDir(t);
  await writeV1(dir, v1Record('vanishing'));
  const box = new DeliveryOutbox({ dir, owner });
  const read = box._readRecord.bind(box);
  box._readRecord = async (id, options) => {
    if (id === 'vanishing') await rm(box.path(id));
    return read(id, options);
  };

  await assert.rejects(box.hasUnsettledDelivery(channelId), (error) => error.code === 'AGY_OUTBOX_CHANGED');
});

test('listPage returns a bounded stable page and a cursor while list retains its compatibility result', async (t) => {
  const dir = await tempDir(t);
  for (const id of ['gamma', 'alpha', 'beta']) await writeV1(dir, v1Record(id));
  const box = new DeliveryOutbox({ dir, owner });

  const first = await box.listPage({ limit: 2 });
  assert.deepEqual(first.records.map((record) => record.recoveryId), ['alpha', 'beta']);
  assert.equal(first.nextCursor, 'beta');
  const second = await box.listPage({ after: first.nextCursor, limit: 2 });
  assert.deepEqual(second.records.map((record) => record.recoveryId), ['gamma']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await box.list()).map((record) => record.recoveryId), ['alpha', 'beta', 'gamma']);
  await assert.rejects(box.listPage({ limit: 1001 }), (error) => error.code === 'AGY_OUTBOX_BOUNDS');
});

test('archive dry-run leaves sent evidence untouched and apply copies exact bytes before removing it', async (t) => {
  const dir = await tempDir(t);
  const archiveDir = join(tmpdir(), 'agy-outbox-archive-' + process.pid + '-' + Date.now());
  t.after(() => rm(archiveDir, { recursive: true, force: true }));
  const box = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'sent-record' });
  const id = await box.begin({ channelId, replyTo, content: 'acknowledged response' });
  await box.update(id, { status: 'sent', eventId });
  const originalBytes = await readFile(box.path(id));

  const dryRun = await box.archiveSent({ archiveDir, dryRun: true });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.eligible, 1);
  assert.equal(dryRun.archived, 0);
  assert.equal(await readFile(box.path(id)).then((bytes) => bytes.equals(originalBytes)), true);
  await assert.rejects(readFile(archiveDir), (error) => error.code === 'ENOENT');

  const applied = await box.archiveSent({ archiveDir, dryRun: false });
  assert.equal(applied.archived, 1);
  assert.equal(applied.skipped, 0);
  assert.deepEqual(await readFile(join(archiveDir, id + '.json')), originalBytes);
  await assert.rejects(readFile(box.path(id)), (error) => error.code === 'ENOENT');
});

test('archive preserves legacy bytes and skips every non-acknowledged status', async (t) => {
  const dir = await tempDir(t);
  const archiveDir = join(tmpdir(), 'agy-outbox-legacy-archive-' + process.pid + '-' + Date.now());
  t.after(() => rm(archiveDir, { recursive: true, force: true }));
  const sentBytes = await writeV1(dir, v1Record('legacy-sent'));
  const unresolved = [
    ['legacy-inflight', 'inflight'],
    ['legacy-uncertain', 'uncertain'],
    ['legacy-failed', 'failed-before-start']
  ];
  const unresolvedBytes = [];
  for (const [id, status] of unresolved) unresolvedBytes.push(await writeV1(dir, v1Record(id, status)));
  const box = new DeliveryOutbox({ dir, owner, relay });

  const result = await box.archiveSent({ archiveDir, dryRun: false });
  assert.equal(result.archived, 1);
  assert.equal(result.skipped, 3);
  assert.deepEqual(await readFile(join(archiveDir, 'legacy-sent.json')), sentBytes);
  for (let index = 0; index < unresolved.length; index += 1) {
    assert.deepEqual(await readFile(join(dir, unresolved[index][0] + '.json')), unresolvedBytes[index]);
  }
  assert.equal((await readdir(dir)).includes('.agy-outbox-store'), false);
  assert.equal(JSON.parse(await readFile(join(archiveDir, 'legacy-sent.json'), 'utf8')).schemaVersion, undefined);
});

test('archive refuses overlapping paths and existing destinations without deleting source evidence', async (t) => {
  const dir = await tempDir(t);
  const box = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'sent-record' });
  const id = await box.begin({ channelId, replyTo, content: 'acknowledged response' });
  await box.update(id, { status: 'sent', eventId });
  const originalBytes = await readFile(box.path(id));

  await assert.rejects(box.archiveSent({ archiveDir: join(dir, 'archive'), dryRun: true }),
    (error) => error.code === 'AGY_OUTBOX_ARCHIVE_PATH');

  const archiveDir = join(tmpdir(), 'agy-outbox-collision-' + process.pid + '-' + Date.now());
  t.after(() => rm(archiveDir, { recursive: true, force: true }));
  await mkdir(archiveDir);
  const collisionBytes = Buffer.from('leave existing archive untouched\n');
  await writeFile(join(archiveDir, id + '.json'), collisionBytes);
  await assert.rejects(box.archiveSent({ archiveDir, dryRun: false }),
    (error) => error.code === 'AGY_OUTBOX_ARCHIVE_EXISTS');
  assert.deepEqual(await readFile(box.path(id)), originalBytes);
  assert.deepEqual(await readFile(join(archiveDir, id + '.json')), collisionBytes);
});

test('writeAtomic enforces immutable delivery identity and legal state transitions', async (t) => {
  const dir = await tempDir(t);
  const box = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'atomic-record' });
  const id = await box.begin({ channelId, replyTo, content: 'original response' });
  const before = await readFile(box.path(id));
  const record = await box.get(id);

  await assert.rejects(box.writeAtomic(id, { ...record, content: 'rewritten response' }),
    (error) => error.code === 'AGY_OUTBOX_TRANSITION');
  assert.deepEqual(await readFile(box.path(id)), before);
  await box.writeAtomic(id, { ...record, status: 'failed-before-start' });
  assert.equal((await box.get(id)).status, 'failed-before-start');
});

test('archive apply refuses a record already held by another native owner', async (t) => {
  const dir = await tempDir(t);
  const archiveDir = join(tmpdir(), 'agy-outbox-locked-archive-' + process.pid + '-' + Date.now());
  t.after(() => rm(archiveDir, { recursive: true, force: true }));
  const box = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'sent-record' });
  const id = await box.begin({ channelId, replyTo, content: 'acknowledged response' });
  await box.update(id, { status: 'sent', eventId });
  const originalBytes = await readFile(box.path(id));
  const lock = await acquireNativeLock(box.lockPath(id));
  try {
    await assert.rejects(box.archiveSent({ archiveDir, dryRun: false }),
      (error) => error.code === 'AGY_NATIVE_LOCK_BUSY');
    assert.deepEqual(await readFile(box.path(id)), originalBytes);
    await assert.rejects(readFile(join(archiveDir, id + '.json')), (error) => error.code === 'ENOENT');
  } finally {
    await lock.release();
  }
});

test('archive rejects a destination below a symlink ancestor', async (t) => {
  const root = await tempDir(t);
  const outboxDir = join(root, 'outbox');
  const realParent = join(root, 'real-parent');
  const aliasParent = join(root, 'alias-parent');
  await mkdir(realParent);
  try {
    await symlink(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('symlink privilege unavailable');
      return;
    }
    throw error;
  }
  const box = new DeliveryOutbox({ dir: outboxDir, owner, relay });

  await assert.rejects(box.archiveSent({
    archiveDir: join(aliasParent, 'nested', 'archive'),
    dryRun: true
  }), (error) => error.code === 'AGY_OUTBOX_ARCHIVE_PATH');
});

test('archive rejects a destination below a non-directory ancestor', async (t) => {
  const root = await tempDir(t);
  const notDirectory = join(root, 'not-a-directory');
  await writeFile(notDirectory, 'synthetic file');
  const box = new DeliveryOutbox({ dir: join(root, 'outbox'), owner, relay });

  await assert.rejects(box.archiveSent({
    archiveDir: join(notDirectory, 'nested', 'archive'),
    dryRun: true
  }), (error) => error.code === 'AGY_OUTBOX_ARCHIVE_PATH');
});

test('archive checks the store binding before creating its destination', async (t) => {
  const dir = await tempDir(t);
  const archiveDir = join(tmpdir(), 'agy-outbox-mismatch-archive-' + process.pid + '-' + Date.now());
  t.after(() => rm(archiveDir, { recursive: true, force: true }));
  const original = new DeliveryOutbox({ dir, owner, relay, idFn: () => 'sent-record' });
  await original.begin({ channelId, replyTo, content: 'acknowledged response' });
  await original.update('sent-record', { status: 'sent', eventId });
  const originalBytes = await readFile(original.path('sent-record'));
  const wrongRelay = new DeliveryOutbox({ dir, owner, relay: 'wss://other-relay.example.invalid/acp' });

  await assert.rejects(wrongRelay.archiveSent({ archiveDir, dryRun: false }),
    (error) => error.code === 'AGY_OUTBOX_STORE_MISMATCH');
  assert.deepEqual(await readFile(original.path('sent-record')), originalBytes);
  await assert.rejects(readFile(archiveDir), (error) => error.code === 'ENOENT');
});
