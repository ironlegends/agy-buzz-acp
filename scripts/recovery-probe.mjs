import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = resolve(process.argv[5]);
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const runtime = resolve(process.argv[2]);
const { acquireNativeLock } = await import(pathToFileURL(join(runtime, 'src/native-lock.js')));
const selection = process.argv[3] || '';
const suffix = process.argv[4] || '';
const owner = 'ab'.repeat(32), channel = '123e4567-e89b-42d3-a456-426614174000', replyTo = 'ef'.repeat(32);
const bridgeKey = createHash('sha256').update(`${owner}:${channel}`).digest('hex');
const sessionKey = createHash('sha256').update(channel).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const jsonLines = async (path) => { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
async function until(fn, label, ms = 20000) {
  const deadline = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await pause(25); } while (Date.now() < deadline);
  throw new Error(`Probe deadline: ${label}`);
}
async function harness(name, { uncertain = false } = {}) {
  const dir = join(here, name + suffix); await mkdir(dir, { recursive: false });
  const inherited = new Set(['path','systemroot','windir','comspec','temp','tmp','userprofile','localappdata','appdata','username','userdomain','homedrive','homepath','pathext','processor_architecture']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toLowerCase())));
  Object.assign(env, { AGY_COMMAND: process.execPath, AGY_FAKE_SCRIPT: join(fixtures, 'fault-provider.mjs'), BUZZ_CLI_COMMAND: process.execPath, BUZZ_FAKE_SCRIPT: join(fixtures, 'fault-publisher.mjs'),
    AGY_SESSION_DIR: join(dir, 'sessions'), AGY_SESSION_OWNER: owner, AGY_OUTBOX_DIR: join(dir, 'outbox'), AGY_OUTBOX_OWNER: owner,
    BUZZ_RELAY_URL: 'wss://fault-probe.invalid', AGY_STEER_HOOK_CONFIGURED: '1', AGY_STEER_INJECTOR_EXCLUSIVE: '1', AGY_STEER_OWNER: owner, AGY_STEER_ROOT_DIR: join(dir, 'steering'),
    PROBE_DIR: dir, PROBE_RUNTIME: runtime, PROBE_PUBLICATION_UNCERTAIN: uncertain ? '1' : '0' });
  const proc = spawn(process.execPath, [join(runtime, 'bin', 'agy-buzz-acp.js')], { env, cwd: dir, shell: false, stdio: ['pipe','pipe','pipe'] });
  let buffer = '', diagnostics = '', next = 1;
  const pending = new Map(), wire = [], commands = new Map();
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (data) => { diagnostics += data; });
  proc.stdout.on('data', (data) => {
    buffer += data;
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line); wire.push(message);
      if (pending.has(message.id)) { const p = pending.get(message.id); clearTimeout(p.timer); pending.delete(message.id); p.resolve(message); }
    }
  });
  const closePromise = new Promise((resolveClose) => proc.once('close', (code, signal) => resolveClose({ code, signal })));
  const call = (method, params = {}) => {
    const id = next++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout ${method}`)); }, 35000);
      pending.set(id, { resolve, reject, timer });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return result;
  };
  const context = (text) => [{ type: 'text', text: `<context>\nChannel: synthetic (#${channel})\nThread root: ${replyTo}\n</context>` }, { type: 'text', text }];
  const initialization = await call('initialize', { protocolVersion: 1 });
  assert.match(initialization.result.agentInfo.version, /^0\.5\./);
  const fresh = await call('session/new', { cwd: dir }); const sessionId = fresh.result.sessionId;
  const app = { dir, proc, sessionId, call, wire, initialization, context,
    trace: () => jsonLines(join(dir, 'trace.jsonl')),
    publications: () => jsonLines(join(dir, 'publications.jsonl')),
    requestReady: async () => {
      const bridge = join(dir, 'steering', `channel-${bridgeKey}`);
      try {
        if (!(await readdir(bridge)).some((file) => file.endsWith('.request.json'))) return false;
        // Existence precedes enqueue's lock release. Dispatch the fixture hook
        // only after enqueue has actually yielded its lock, not halfway through.
        const lock = await acquireNativeLock(join(bridge, '.steering.lock'));
        await lock.release(); return true;
      } catch (error) {
        if (['ENOENT', 'AGY_NATIVE_LOCK_BUSY'].includes(error.code)) return false;
        throw error;
      }
    },
    bridge: () => readJson(join(dir, 'steering', `channel-${bridgeKey}`, 'state.json')),
    record: () => readJson(join(dir, 'sessions', `${sessionKey}.json`)),
    archives: async () => { try { return (await readdir(join(dir, 'steering'))).filter((name) => name.includes('-archived-')); } catch { return []; } },
    prompt: (text) => { app.lastPromptId = next; return call('session/prompt', { sessionId, prompt: context(text) }); },
    steer: () => call('_session/steering', { sessionId, prompt: [{ type: 'text', text: 'Synthetic correction: answer CORRECTED only.' }] }),
    async command(pid, message) { const n = (commands.get(pid) ?? 0) + 1; commands.set(pid, n); await writeFile(join(dir, `command.${pid}.${n}.json`), JSON.stringify(message)); },
    async close() {
      proc.stdin.end();
      const ended = await Promise.race([closePromise, pause(5000).then(() => null)]);
      if (!ended) { proc.kill(); await closePromise; }
      for (const { timer } of pending.values()) clearTimeout(timer);
      // The adapter closes its child on EOF. Never signal historical PIDs: they may be reused.
      await writeFile(join(dir, 'adapter.stderr.log'), diagnostics);
      await writeFile(join(dir, 'adapter-wire.json'), JSON.stringify(wire, null, 2));
    },
    diagnostics: () => diagnostics
  };
  return app;
}
async function started(app, nth) {
  return until(async () => {
    const response = app.wire.find((m) => m.id === app.lastPromptId);
    if (response?.error) throw new Error(`Provider startup refused: ${JSON.stringify(response.error)}; ${app.diagnostics()}`);
    return (await app.trace()).filter((item) => item.kind === 'promptReceived')[nth - 1];
  }, `provider prompt ${nth}`);
}
async function ordinary(app, nth) {
  const turn = app.prompt(`Synthetic independent turn ${nth}: answer BASE only.`);
  const provider = await started(app, nth);
  await app.command(provider.pid, { kind: 'finish' });
  const response = await turn;
  assert.equal(response.result?.publication?.status, 'sent', JSON.stringify(response));
  return response;
}
const checks = [];
async function check(name, fn, options) {
  if (selection && selection !== name) return;
  const began = Date.now(); let app; const evidence = {};
  try {
    app = await harness(name, options); evidence.adapterPid = app.proc.pid;
    await fn(app, evidence); evidence.verdict = 'PASS';
  } catch (e) { evidence.verdict = 'FAIL'; evidence.error = e.message; }
  finally {
    if (app) {
      evidence.record = await app.record(); evidence.bridge = await app.bridge(); evidence.archives = await app.archives();
      evidence.publications = await app.publications(); evidence.providerTrace = await app.trace(); evidence.diagnostics = app.diagnostics();
      await app.close();
    }
  }
  evidence.name = name; evidence.durationMs = Date.now() - began;
  checks.push(evidence); await writeFile(join(here, `results${suffix}.json`), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ name, verdict: evidence.verdict, durationMs: evidence.durationMs, error: evidence.error, adapterPid: evidence.adapterPid }));
}

for (const [name, delay] of [['confirmed-steering', 0], ['delayed-confirmation', 1200]]) {
  await check(name, async (app, evidence) => {
    await ordinary(app, 1);
    const turn = app.prompt('Synthetic turn requiring a correction.'); const provider = await started(app, 2);
    const steer = app.steer();
    await until(app.requestReady, 'queued correction request file');
    await app.command(provider.pid, { kind: 'claim', confirmAfterMs: delay });
    const claimed = await until(async () => (await app.trace()).find((t) => t.pid === provider.pid && t.kind === 'claimReturned'), 'real hook return');
    assert.equal(claimed.injections, 1); evidence.confirmAfterHookMs = delay;
    evidence.steer = await steer; assert.equal(evidence.steer.result?.outcome, 'injected', JSON.stringify(evidence.steer));
    await app.command(provider.pid, { kind: 'finish' });
    evidence.turn = await turn; assert.equal(evidence.turn.result?.publication?.status, 'sent', JSON.stringify(evidence.turn));
    assert.equal((await app.publications())[1]?.content, 'CORRECTED');
    await ordinary(app, 3); assert.equal((await app.record()).status, 'ready');
    assert.equal(app.proc.exitCode, null, 'adapter was not restarted');
    assert.equal((await app.publications()).length, 3);
  });
}
for (const [name, confirmAfterMs] of [['claim-timeout-same-process-recovery', -1], ['late-confirmation-after-timeout', 7500]]) {
await check(name, async (app, evidence) => {
  await ordinary(app, 1);
  const turn = app.prompt('Synthetic first attempt. Do not replay any real task.'); const provider = await started(app, 2);
  const steer = app.steer();
  await until(app.requestReady, 'queued correction request file');
  await app.command(provider.pid, { kind: 'claim', confirmAfterMs });
  const claimed = await until(async () => (await app.trace()).find((t) => t.pid === provider.pid && t.kind === 'claimReturned'), 'hook handoff');
  assert.equal(claimed.injections, 1);
  evidence.failedTurn = await turn; evidence.steer = await steer;
  assert.match(evidence.failedTurn.error?.message ?? '', /claim timed out/);
  assert.match(evidence.steer.error?.message ?? '', /claim timed out/);
  evidence.beforeRetry = { session: await app.record(), bridge: await app.bridge(), publications: (await app.publications()).length };
  assert.equal(evidence.beforeRetry.session.status, 'blocked'); assert.equal(evidence.beforeRetry.bridge.guardBlocked, true);
  assert.equal(evidence.beforeRetry.publications, 1, 'the timed-out turn must not publish');
  evidence.providerRetired = await until(() => { try { process.kill(provider.pid, 0); return false; } catch { return true; } }, 'provider death');
  assert.equal(app.proc.exitCode, null);
  const retry = app.prompt('NEW independent synthetic turn after the failure. Answer BASE only.');
  const next = await Promise.race([started(app, 3).then((provider) => ({ provider })), retry.then((error) => ({ error }))]);
  if (next.provider) await app.command(next.provider.pid, { kind: 'finish' });
  evidence.retry = await retry;
  evidence.sameAdapterPid = app.proc.pid === evidence.adapterPid && app.proc.exitCode === null;
  assert.equal(evidence.retry.result?.publication?.status, 'sent', `Recovery failed: ${JSON.stringify(evidence.retry)}`);
  assert.equal((await app.record()).status, 'ready');
  assert.equal((await app.publications()).length, 2);
  assert.equal((await app.trace()).filter((t) => t.kind === 'providerStarted').length, 3);
  assert.equal((await app.trace()).filter((t) => t.kind === 'claimReturned').length, 1, 'uncertain correction was not replayed');
  assert.equal((await app.archives()).length, 1);
  const lastPrompt = (await app.trace()).filter((t) => t.kind === 'promptReceived').at(-1).message;
  assert.ok(lastPrompt.endsWith('NEW independent synthetic turn after the failure. Answer BASE only.'));
  assert.equal((await app.record()).conversationId, 'fault-probe-conversation');
});
}
await check('active-turn-not-reconciled', async (app, evidence) => {
  const turn = app.prompt('Synthetic active turn.'); const provider = await started(app, 1);
  const steer = app.steer();
  await until(app.requestReady, 'queued correction request file');
  const secondSession = await app.call('session/new', { cwd: app.dir });
  evidence.competing = await app.call('session/prompt', { sessionId: secondSession.result.sessionId, prompt: app.context('Competing synthetic request') });
  assert.ok(evidence.competing.error); assert.deepEqual(await app.archives(), []);
  assert.equal((await app.trace()).filter((t) => t.kind === 'providerStarted').length, 1);
  await app.command(provider.pid, { kind: 'claim', confirmAfterMs: 0 });
  assert.equal((await steer).result?.outcome, 'injected');
  await app.command(provider.pid, { kind: 'finish' }); assert.equal((await turn).result?.publication?.status, 'sent');
});
await check('uncertain-publication-not-retried', async (app, evidence) => {
  const turn = app.prompt('Synthetic publication with missing acceptance.'); const provider = await started(app, 1);
  await app.command(provider.pid, { kind: 'finish' }); evidence.first = await turn;
  assert.equal(evidence.first.result?.publication?.status, 'uncertain');
  evidence.next = await app.prompt('NEW synthetic request: must be held behind uncertain publication.');
  assert.ok(evidence.next.error); assert.match(app.diagnostics(), /unsettled delivery/);
  assert.equal((await app.publications()).length, 1);
  assert.equal((await app.trace()).filter((t) => t.kind === 'providerStarted').length, 1);
}, { uncertain: true });
console.log(JSON.stringify({ total: checks.length, pass: checks.filter((c) => c.verdict === 'PASS').length, fail: checks.filter((c) => c.verdict === 'FAIL').length }));
process.exitCode = checks.some((c) => c.verdict === 'FAIL') ? 1 : 0;
