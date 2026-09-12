import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedChildEnvironment } from '../scripts/environment-support.js';
import { createSteeringCoordinator } from '../src/steering.js';

function runHook(inputText, env = {}) {
  return runHookChunks([Buffer.from(inputText, 'utf8')], env);
}

function runHookChunks(chunks, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/agy-buzz-steer-hook.js'], {
      cwd: new URL('..', import.meta.url),
      env: isolatedChildEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`steering helper exited with ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim() || '{}'));
    });
    (async () => {
      try {
        for (const chunk of chunks) {
          child.stdin.write(chunk);
          await new Promise((done) => setImmediate(done));
        }
        child.stdin.end();
      } catch (error) { reject(error); }
    })();
  });
}

test('stdin within the configured limit is parsed normally', async () => {
  const result = await runHook(JSON.stringify({}), { AGY_STEER_HOOK_MAX_STDIN_BYTES: '1024' });
  assert.deepEqual(result, {});
});

test('stdin over the configured limit is treated as invalid input, not buffered without bound', async () => {
  const oversized = JSON.stringify({ conversationId: 'x'.repeat(2000) });
  const result = await runHook(oversized, { AGY_STEER_HOOK_MAX_STDIN_BYTES: '64' });
  assert.deepEqual(result, {}, 'oversized input is discarded and treated as an empty/invalid hook call');
});

test('hook decodes a fragmented multi-byte stdin frame and preserves the injected content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-hook-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coordinator = await createSteeringCoordinator({
    rootDir: root,
    ownerId: 'ab'.repeat(32),
    channelId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-hook-input',
    conversationId: 'conversation-hook-input',
    injectorExclusive: true,
    hookConfigured: true
  });
  await coordinator.enqueue('réponse réellement injectée', { claimFloorStep: 0 });
  const metadata = JSON.stringify({ conversationId: 'conversation-hook-input', invocationNum: 7, workspacePaths: [], note: 'é' });
  const bytes = Buffer.from(metadata, 'utf8');
  const marker = Buffer.from('é', 'utf8');
  const cut = bytes.indexOf(marker) + 1;
  const result = await runHookChunks([bytes.subarray(0, cut), bytes.subarray(cut)], coordinator.bridgeEnv());
  assert.deepEqual(result.injectSteps, [{ userMessage: 'réponse réellement injectée' }]);
  assert.equal(result.terminationBehavior, 'force_continue');
});
