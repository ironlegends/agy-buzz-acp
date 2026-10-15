import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AgySession, PINNED_MODEL } from '../src/agy-session.js';
import { createAcpServer } from '../src/acp-server.js';
import { SessionState } from '../src/session-state.js';
import { DeliveryOutbox } from '../src/delivery/outbox.js';
import { listModels } from '../src/models.js';

// This explicit command makes authenticated, sandboxed provider turns. Publication
// is an in-memory fake: no Buzz executable, credentials or relay is ever used.
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--command' || !isAbsolute(args[1]) || args[2] !== '--turns') {
  process.stderr.write('Usage: node scripts/provider-canary.mjs --command /absolute/path/to/agy --turns\n');
  process.exitCode = 2;
} else {
  for (const key of Object.keys(process.env)) if (/^(?:AGY_|BUZZ_)/i.test(key)) delete process.env[key];
  const command = args[1];
  const binaryHash = createHash('sha256').update(await readFile(command)).digest('hex');
  const versionProbe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, shell: false });
  assert.equal(versionProbe.status, 0, 'provider version probe failed');
  const providerVersion = versionProbe.stdout.trim();
  const models = await listModels({ command, timeoutMs: 30000 });
  assert.ok(models.some(model => model.modelId === PINNED_MODEL), 'pinned canary model unavailable');
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'agy-provider-canary-')));
  const owner = 'ab'.repeat(32), relay = 'wss://canary.invalid';
  const channelId = randomUUID(), replyTo = 'cd'.repeat(32);
  const state = new SessionState({ dir: join(cwd, 'sessions'), owner, relay });
  const outbox = new DeliveryOutbox({ dir: join(cwd, 'outbox'), owner, relay });
  const events = new Set(), stepTypes = new Set(), publications = [], messages = [];
  const output = new PassThrough(); let wire = '';
  output.on('data', chunk => {
    wire += chunk;
    for (;;) {
      const n = wire.indexOf('\n'); if (n < 0) break;
      messages.push(JSON.parse(wire.slice(0, n))); wire = wire.slice(n + 1);
    }
  });
  const spawnProvider = (exe, argv, options) => {
    const child = spawn(exe, [...argv, '--log-file', join(cwd, `${randomUUID()}.log`)], options);
    let lineBuffer = '';
    child.stdout.on('data', chunk => {
      lineBuffer += chunk;
      for (;;) {
        const n = lineBuffer.indexOf('\n'); if (n < 0) break;
        try {
          const event = JSON.parse(lineBuffer.slice(0, n));
          if (typeof event.event === 'string') events.add(event.event);
          if (typeof event.step_update?.step_type === 'string') stepTypes.add(event.step_update.step_type);
        } catch {}
        lineBuffer = lineBuffer.slice(n + 1);
      }
    });
    return child;
  };
  const server = createAcpServer({ input: new PassThrough(), output, diagnostics: new PassThrough(),
    sessionFactory: options => new AgySession({ ...options, command, spawnFn: spawnProvider }),
    publisherFactory: () => ({ async publish(request) { publications.push(request); return { status: 'sent', eventId: 'ef'.repeat(32) }; } }),
    sessionStateFactory: () => state, outboxFactory: () => outbox, identityFactory: async () => owner,
    modelCatalogFactory: async () => models, steeringSupported: false
  });
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = ++nextId;
    await server.handle({ jsonrpc: '2.0', id, method, params });
    const response = messages.find(message => message.id === id);
    assert.ok(response, `missing ${method} response`);
    assert.ok(!response.error, `${method} refused: ${response.error?.message}`);
    return response.result;
  };
  const prompt = (sessionId, text) => ({ sessionId, prompt: [
    { type: 'text', text: '[Base]\nIsolated compatibility canary. Use no tools, files, network calls or skills.' },
    { type: 'text', text: `[Context]\nChannel: canary (#${channelId})\nThread root: ${replyTo}` },
    { type: 'text', text }
  ] });
  let timer;
  try {
    const run = async () => {
      await rpc('initialize', { protocolVersion: 1 });
      const { sessionId } = await rpc('session/new', { cwd });
      const firstMarker = `CANARY_${randomUUID().replaceAll('-', '')}`;
      await rpc('session/prompt', prompt(sessionId, `Reply with exactly ${firstMarker}. No tools.`));
      assert.ok(publications[0]?.content.includes(firstMarker), 'normal response marker missing');
      const firstConversation = server.sessions.get(sessionId).session.conversationId;
      assert.ok(firstConversation, 'provider conversation association missing');
      const secondMarker = `CANARY_${randomUUID().replaceAll('-', '')}`;
      await rpc('session/prompt', prompt(sessionId, `Reply with exactly ${secondMarker}. No tools.`));
      assert.ok(publications[1]?.content.includes(secondMarker), 'resumed response marker missing');
      assert.equal(server.sessions.get(sessionId).session.conversationId, firstConversation, 'resume changed conversation');
      const third = rpc('session/prompt', prompt(sessionId, 'Reply with exactly CANCEL_CANARY. No tools.'));
      const deadline = Date.now() + 5000;
      while (!server.sessions.get(sessionId).session.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      await server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      assert.equal((await third).stopReason, 'cancelled');
      assert.equal(publications.length, 2, 'cancellation published a response');
      return { normal: 'PASS', checkpointResume: 'PASS', cancel: 'PASS' };
    };
    const result = await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('provider canary timed out')), 90000);
    })]);
    assert.equal(createHash('sha256').update(await readFile(command)).digest('hex'), binaryHash, 'provider binary changed during canary');
    console.log(JSON.stringify({ providerVersion, binarySha256: binaryHash, nodeVersion: process.version, platform: process.platform,
      models: models.length, ...result, steering: 'NOT_RUN_requires_dedicated_hook',
      events: [...events].sort(), stepTypes: [...stepTypes].sort(), fakePublications: publications.length, realPublications: 0 }));
  } finally {
    clearTimeout(timer);
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
