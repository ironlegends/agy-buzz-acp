import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';

const execFile = promisify(execFileCallback);

test('state migration CLI documents dry-run and explicit apply modes', async () => {
  const { stdout } = await execFile(process.execPath, ['bin/agy-buzz-state.js', '--help'], { windowsHide: true });
  assert.match(stdout, /--source <legacy-dir>/);
  assert.match(stdout, /--destination <absent-dir>/);
  assert.match(stdout, /--apply/);
  assert.match(stdout, /All old writers must be stopped/);
});

test('state migration CLI refuses incomplete invocation before reading credentials', async () => {
  await assert.rejects(execFile(process.execPath, ['bin/agy-buzz-state.js'], { windowsHide: true }),
    (error) => error.code === 1 && /source and destination are required/.test(error.stderr));
});

test('the offline migration accepts the documented relay alias without enabling runtime publication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-state-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'legacy'); await mkdir(source, { mode: 0o700 });
  await assert.rejects(execFile(process.execPath, ['bin/agy-buzz-state.js', '--source', source,
    '--destination', join(root, 'canonical')], { windowsHide: true,
    env: isolatedChildEnvironment({ AGY_SESSION_OWNER: 'a'.repeat(64), AGY_RELAY_URL: 'wss://canary.invalid' }) }),
  error => error.code === 1 && /contains no session records/.test(error.stderr));
});
