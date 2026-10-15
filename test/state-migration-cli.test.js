import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

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
