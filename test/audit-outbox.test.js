import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeliveryOutbox, validateOutboxRecord } from '../src/delivery/outbox.js';

const owner = 'ab'.repeat(32);
const channelId = '11111111-1111-4111-8111-111111111111';
const replyTo = 'cd'.repeat(32);
const eventId = 'ef'.repeat(32);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-audit-outbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new DeliveryOutbox({ dir, owner, idFn: () => 'sample' });
}
const message = { channelId, replyTo, content: 'synthetic response' };

test('A01: invalid semantic records refuse the recovery scan', async (t) => {
  const box = await fixture(t);
  await writeFile(box.path('sample'), JSON.stringify({ channelId, status: 'INFLIGHT' }));
  await assert.rejects(box.list());
});

test('A02: a delayed reader cannot overwrite a concurrently persisted acknowledgement', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  const reader = new DeliveryOutbox({ dir: box.dir, owner });
  const read = reader.readRaw.bind(reader);
  let signalRead;
  let releaseRead;
  const readHappened = new Promise((resolve) => { signalRead = resolve; });
  const holdRead = new Promise((resolve) => { releaseRead = resolve; });
  reader.readRaw = async (id) => {
    const snapshot = await read(id);
    signalRead();
    await holdRead;
    return snapshot;
  };
  const pending = reader.get('sample');
  try {
    await readHappened;
    await box.update('sample', { status: 'sent', eventId });
  } finally {
    releaseRead();
  }
  await pending;
  const final = await box.readRaw('sample');
  assert.equal(final.status, 'sent');
  assert.equal(final.eventId, eventId);
});

test('A03: record symlinks are refused and their target is unchanged', async (t) => {
  const box = await fixture(t);
  const target = join(box.dir, 'target.txt');
  await writeFile(target, '{"outside":"synthetic"}');
  try {
    await symlink(target, box.path('sample'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('symlink privilege unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(box.readRaw('sample'));
  assert.equal(await readFile(target, 'utf8'), '{"outside":"synthetic"}');
});

test('A04: validator requires event-format destinations and acknowledgements for sent', () => {
  const record = { ...message, recoveryId: 'sample', owner, status: 'sent',
    createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z' };
  assert.equal(validateOutboxRecord({ ...record, eventId, replyTo: 'not-an-event' }), false);
  assert.equal(validateOutboxRecord(record), false);
  assert.equal(validateOutboxRecord({ ...record, eventId }), true);
});

for (const mismatch of ['owner', 'recoveryId']) {
  test(`A05: store read refuses mismatched ${mismatch}`, async (t) => {
    const box = await fixture(t);
    await box.begin(message);
    const record = await box.readRaw('sample');
    record[mismatch] = mismatch === 'owner' ? '12'.repeat(32) : 'different-file';
    await writeFile(box.path('sample'), JSON.stringify(record));
    await assert.rejects(box.list());
  });
}

test('A06: get preserves both raw inflight status and every byte on disk', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  const before = await readFile(box.path('sample'));
  assert.equal((await box.get('sample')).status, 'inflight');
  assert.deepEqual(await readFile(box.path('sample')), before);
});

test('A07: begin refuses a recovery-id collision without replacing the existing record', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  const before = await readFile(box.path('sample'));
  await assert.rejects(box.begin(message), (error) => error.code === 'AGY_OUTBOX_COLLISION');
  assert.deepEqual(await readFile(box.path('sample')), before);
});

test('A08: sent acknowledgements are durable and immutable', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  await box.update('sample', { status: 'sent', eventId });
  const before = await readFile(box.path('sample'));
  await assert.rejects(box.update('sample', { status: 'sent', eventId: 'ab'.repeat(32) }),
    (error) => error.code === 'AGY_OUTBOX_TRANSITION');
  assert.deepEqual(await readFile(box.path('sample')), before);
});

test('A09: a failed final acknowledgement write leaves the durable claim uncertain and cleans its temporary file', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the final rename failure probe relies on Windows read-only file semantics');
    return;
  }
  const box = await fixture(t);
  await box.begin(message);
  await box.update('sample', { status: 'failed-before-start' });
  const result = await box.retry('sample', {
    owner,
    publish: async () => {
      await chmod(box.path('sample'), 0o444);
      return { status: 'sent', eventId };
    }
  });
  assert.equal(result.status, 'uncertain');
  assert.equal((await box.readRaw('sample')).status, 'uncertain');
  assert.equal((await readdir(box.dir)).some((name) => name.endsWith('.tmp')), false);
});

test('A10: records with invalid UTF-8 bytes are refused as corrupt', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  const record = await box.readRaw('sample');
  const bytes = Buffer.from(`${JSON.stringify({ ...record, content: 'invalid-utf8-marker' })}\n`, 'utf8');
  const marker = Buffer.from('invalid-utf8-marker', 'utf8');
  const offset = bytes.indexOf(marker);
  assert.notEqual(offset, -1);
  bytes[offset] = 0xff;
  await writeFile(box.path('sample'), bytes);
  await assert.rejects(box.readRaw('sample'), (error) => error.code === 'AGY_OUTBOX_CORRUPT');
});

test('A11: records with more than one hardlink are refused', async (t) => {
  const box = await fixture(t);
  await box.begin(message);
  const recordPath = box.path('sample');
  const hardlinkTarget = join(box.dir, 'hardlink-target.json');
  const before = await readFile(recordPath);
  await writeFile(hardlinkTarget, before);
  await rm(recordPath);
  await link(hardlinkTarget, recordPath);
  await assert.rejects(box.readRaw('sample'), (error) => error.code === 'AGY_OUTBOX_LINK');
  assert.deepEqual(await readFile(recordPath), before);
  assert.deepEqual(await readFile(hardlinkTarget), before);
});
