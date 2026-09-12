import { appendFile, access, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, runtimeRoot, probeRoot] = process.argv.slice(2);
const owner = 'ab'.repeat(32);
const channelId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const replyTo = 'b'.repeat(64);
const stateDir = join(probeRoot, 'state');
const outboxDir = join(probeRoot, 'outbox');
const heartbeatPath = join(probeRoot, 'provider.heartbeat.jsonl');
const providerMetaPath = join(probeRoot, 'provider.json');
const stopPath = join(probeRoot, 'provider.stop');

async function loadRuntime() {
  const [{ createAcpServer }, { DeliveryOutbox }, { SessionState }, { isolatedChildEnvironment }] = await Promise.all([
    import(pathToFileURL(join(runtimeRoot, 'src', 'acp-server.js'))),
    import(pathToFileURL(join(runtimeRoot, 'src', 'delivery', 'outbox.js'))),
    import(pathToFileURL(join(runtimeRoot, 'src', 'session-state.js'))),
    import(pathToFileURL(join(runtimeRoot, 'scripts', 'environment-support.js')))
  ]);
  return { createAcpServer, DeliveryOutbox, SessionState, isolatedChildEnvironment };
}

async function waitForFile(path) {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function runProvider() {
  let sequence = 0;
  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    await appendFile(join(probeRoot, 'provider.stopped'), `${JSON.stringify({ pid: process.pid, sequence })}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void finish(); });
  process.on('SIGINT', () => { void finish(); });
  await writeFile(providerMetaPath, `${JSON.stringify({ pid: process.pid, parentPid: Number(process.env.LIFECYCLE_PARENT_PID) })}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  const heartbeat = async () => {
    if (stopping) return;
    try {
      await access(stopPath);
      await finish();
      return;
    } catch {}
    sequence += 1;
    await appendFile(heartbeatPath, `${JSON.stringify({ pid: process.pid, parentPid: Number(process.env.LIFECYCLE_PARENT_PID), sequence })}\n`);
  };
  await heartbeat();
  const timer = setInterval(() => { void heartbeat(); }, 40);
  await new Promise(() => {});
  clearInterval(timer);
}

function lifecyclePrompt() {
  return [
    { type: 'text', text: `[Context]\nChannel: synthetic (#${channelId})\nThread root: ${replyTo}` },
    { type: 'text', text: 'parent turn remains active' }
  ];
}

async function createServer({ SessionState, DeliveryOutbox, createAcpServer, sessionFactory, publisherFactory }) {
  const state = new SessionState({ dir: stateDir, owner, relay: 'wss://probe.invalid' });
  const outbox = new DeliveryOutbox({ dir: outboxDir, owner });
  const output = new PassThrough();
  const server = createAcpServer({
    input: new PassThrough(),
    output,
    diagnostics: new PassThrough(),
    sessionStateFactory: () => state,
    outboxFactory: () => outbox,
    identityFactory: async () => owner,
    modelCatalogFactory: async () => [],
    sessionFactory,
    publisherFactory
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: probeRoot } });
  return { state, outbox, server, output, sessionId: [...server.sessions.keys()][0] };
}

async function runParent() {
  const { createAcpServer, DeliveryOutbox, SessionState, isolatedChildEnvironment } = await loadRuntime();
  const provider = spawn(process.execPath, [fileURLToPath(import.meta.url), 'provider', runtimeRoot, probeRoot], {
    cwd: runtimeRoot,
    env: isolatedChildEnvironment({ LIFECYCLE_PARENT_PID: String(process.pid) }),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  provider.unref();
  await waitForFile(providerMetaPath);
  const hold = setInterval(() => {}, 1000);
  const harness = await createServer({
    SessionState,
    DeliveryOutbox,
    createAcpServer,
    sessionFactory: () => ({
      prompt: async () => new Promise(() => {}),
      getConversationId: () => 'conversation-parent',
      hasConfirmedConversation: () => true,
      setTrustedConversation() {},
      retireForCheckpoint: async () => 'conversation-parent',
      close() {}
    }),
    publisherFactory: () => ({ publish: async () => ({ status: 'sent', eventId: 'c'.repeat(64) }) })
  });
  void harness.server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: harness.sessionId, prompt: lifecyclePrompt() }
  });
  await waitForFile(harness.state.path(channelId));
  process.stdout.write(`${JSON.stringify({
    kind: 'blocked',
    parentPid: process.pid,
    providerMetaPath,
    heartbeatPath,
    stopPath,
    channelId
  })}\n`);
  await new Promise(() => {});
  clearInterval(hold);
}

async function runResume() {
  const { createAcpServer, DeliveryOutbox, SessionState } = await loadRuntime();
  let providerCalls = 0;
  let publisherCalls = 0;
  const harness = await createServer({
    SessionState,
    DeliveryOutbox,
    createAcpServer,
    sessionFactory: () => ({
      prompt: async () => { providerCalls += 1; return 'unsafe replay'; },
      getConversationId: () => 'conversation-resumed',
      hasConfirmedConversation: () => true,
      setTrustedConversation() {},
      retireForCheckpoint: async () => 'conversation-resumed',
      close() {}
    }),
    publisherFactory: () => ({
      publish: async () => {
        publisherCalls += 1;
        return { status: 'sent', eventId: 'd'.repeat(64) };
      }
    })
  });
  const output = harness.output;
  const messages = [];
  let buffer = '';
  output?.setEncoding?.('utf8');
  output?.on?.('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  const id = 3;
  await harness.server.handle({
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: { sessionId: harness.sessionId, prompt: lifecyclePrompt() }
  });
  process.stdout.write(`${JSON.stringify({
    kind: 'resume-result',
    rpc: messages.find((message) => message.id === id),
    providerCalls,
    publisherCalls
  })}\n`);
  await harness.server.close();
  await harness.state.release();
}

if (mode === 'provider') await runProvider();
else if (mode === 'parent') await runParent();
else if (mode === 'resume') await runResume();
else throw new Error(`unknown lifecycle fixture mode: ${mode}`);
