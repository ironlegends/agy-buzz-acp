import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgySession } from '../src/agy-session.js';
import { createAcpServer } from '../src/acp-server.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

function child() {
  const c = new EventEmitter(); c.stdout = new PassThrough(); c.stdin = new EventEmitter();
  c.writes = []; c.stdin.write = (s) => { c.writes.push(JSON.parse(s)); return true; };
  c.stdin.end = () => {}; c.kill = () => { queueMicrotask(() => c.emit('close', 0)); return true; };
  return c;
}
for (const systemPrompt of [undefined, 'Configured system instructions.']) {
  test(`bridge directive is present without depending on systemPrompt (${Boolean(systemPrompt)})`, async () => {
    const c = child(); const s = new AgySession({ systemPrompt, spawnFn: () => c });
    const p = s.prompt('Platform says use buzz messages send.').catch(() => null);
    assert.match(c.writes[0].message.content, /The wrapper publishes your final response/);
    assert.equal((c.writes[0].message.content.match(/--- Buzz ACP bridge ---/g) || []).length, 1);
    s.close(); await p;
  });
}
test('a restored conversation also receives the publication directive', async () => {
  const c = child(); const s = new AgySession({ spawnFn: () => c });
  s.setTrustedConversation('restored-conversation');
  const p = s.prompt('A new request in an old conversation.').catch(() => null);
  c.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'restored-conversation' }) + '\n');
  assert.match(c.writes[0].message.content, /The wrapper publishes your final response/);
  s.close(); await p;
});
for (const response of ['', ' \r\n\t', undefined, { invalid: true }]) {
  test(`empty or invalid answer is never published: ${JSON.stringify(response)}`, async () => {
    const output = new PassThrough(); let wire = ''; output.on('data', (s) => { wire += s; });
    let published = 0, prepared = 0;
    const server = createAcpServer({ input: new PassThrough(), output, diagnostics: new PassThrough(),
      ...isolatedServerOptions({ sessionFactory: () => ({ prompt: async () => response, close() {} }),
        publisherFactory: () => ({ publish: async () => { published++; return { status: 'sent' }; } }),
        outboxFactory: () => ({ enabled: false, begin: async () => { prepared++; return null; } }) }) });
    try {
      await server.handle({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:1 } });
      await server.handle({ jsonrpc:'2.0', id:2, method:'session/new', params:{ cwd:process.cwd() } });
      const sessionId = [...server.sessions.keys()][0];
      await server.handle({ jsonrpc:'2.0', id:3, method:'session/prompt', params:{ sessionId, prompt:[
        { type:'text', text:`<context>\nChannel: test (#123e4567-e89b-42d3-a456-426614174000)\nThread root: ${'a'.repeat(64)}\n</context>` },
        { type:'text', text:'Synthetic question' } ] } });
      const result = wire.trim().split('\n').map(JSON.parse).find((m) => m.id === 3);
      assert.equal(published, 0); assert.equal(prepared, 0);
      assert.match(result.error?.message ?? '', /empty response/);
    } finally { await server.close(); }
  });
}
