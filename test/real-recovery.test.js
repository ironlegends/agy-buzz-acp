import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';
const exec = promisify(execFile);

test('real stdio adapter, AgySession, hook and native storage survive the fault matrix', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-real-recovery-'));
  const runtime = process.env.PROBE_RUNTIME_UNDER_TEST || fileURLToPath(new URL('..', import.meta.url));
  try {
    const { stdout } = await exec(process.execPath, [fileURLToPath(new URL('../scripts/recovery-probe.mjs', import.meta.url)),
      runtime, '', '', dir], { env: isolatedChildEnvironment(), timeout: 170000, maxBuffer: 1024 * 1024 });
    const results = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'));
    assert.equal(results.length, 6, stdout);
    for (const r of results) assert.equal(r.verdict, 'PASS', `${r.name}: ${r.error ?? ''}`);
    const recovered = results.find((r) => r.name === 'claim-timeout-same-process-recovery');
    assert.equal(recovered.providerRetired, true);
    assert.equal(recovered.sameAdapterPid, true);
    assert.equal(recovered.retry.result.publication.status, 'sent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
