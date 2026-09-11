import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStateDirectory } from '../src/status.js';

test('diagnostics distinguish a native lock file without claiming occupancy or changing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-native-lock-status-'));
  try {
    const file = join(dir, 'scope.lock');
    await writeFile(file, '');
    const result = await inspectStateDirectory(dir, { kind: 'session',
      processAliveImpl: () => { throw new Error('Native locks have no authoritative PID'); } });
    assert.equal(result.locks['native-file'], 1);
    assert.equal(result.locks['live-pid'], 0);
    assert.equal(result.locks.stale, 0);
    assert.equal(await readFile(file, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
