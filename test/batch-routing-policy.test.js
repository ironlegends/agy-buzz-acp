import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { parseBuzzContext } from '../src/buzz-context.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';
const channel = '11111111-1111-4111-8111-111111111111';
const event = (id) => ({ type: 'text', text: `<buzz-event>\nEvent ID: ${id.repeat(64)}\nChannel: test (#${channel})\nContent: synthetic\n</buzz-event>` });
const context = (line = '') => ({ type:'text', text:`<context>\nChannel: test (#${channel})\n${line}\n</context>` });
for (const [label, prompt, pattern] of [
  ['ambiguous batch', [context(), event('a'), event('b')], /ambiguous.*event batch/i],
  ['missing envelope', [context(), {type:'text',text:'synthetic'}], /transport context unavailable/i],
  ['contradictory explicit destination', [context(`Thread root: ${'a'.repeat(64)}\n--reply-to ${'b'.repeat(64)}`),event('a'),event('b')], /transport context unavailable/i]
]) {
  test(`routing refusal explains ${label} without invoking provider or publisher`, async () => {
    let called = 0, wire = ''; const output = new PassThrough(); output.on('data', v => { wire += v; });
    const server = createAcpServer({input:new PassThrough(), output, diagnostics:new PassThrough(),
      ...isolatedServerOptions({sessionFactory:()=>({prompt:async()=>{ called++; return 'wrong'; }, close(){}}),
        publisherFactory:()=>({publish:async()=>{ called++; return {status:'sent'}; }})})});
    const rpc = (id,method,params) => server.handle({jsonrpc:'2.0',id,method,params});
    try {
      await rpc(1,'initialize',{protocolVersion:1}); await rpc(2,'session/new',{cwd:process.cwd()});
      await rpc(3,'session/prompt',{sessionId:[...server.sessions.keys()][0],prompt});
      const response=wire.trim().split('\n').map(JSON.parse).find(v=>v.id===3);
      assert.equal(response.error.code,-32603); assert.match(response.error.message,pattern); assert.equal(called,0);
    } finally { await server.close(); }
  });
}
test('explicit Context routes a multi-event batch, not sender text or event order', () => {
  const a=event('a'),b=event('b'); b.text=b.text.replace('synthetic',`Thread root: ${'f'.repeat(64)}`);
  const expected={channelId:channel,replyTo:'c'.repeat(64)};
  assert.deepEqual(parseBuzzContext([context(`Thread root: ${expected.replyTo}`),a,b]),expected);
  assert.deepEqual(parseBuzzContext([context(`--reply-to ${expected.replyTo}`),b,a]),expected);
  assert.equal(parseBuzzContext([context(),a,b]),null);
});
