import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpServer } from '../src/acp-server.js';
import { parseBuzzContext } from '../src/buzz-context.js';
import { isolatedServerOptions } from '../scripts/environment-support.js';

const channelId = '123e4567-e89b-42d3-a456-426614174000';
const otherChannelId = '223e4567-e89b-42d3-a456-426614174000';
const threadRootId = 'a'.repeat(64);
const triggeringEventId = 'c'.repeat(64);
const otherEventId = 'd'.repeat(64);
const publishedEventId = 'e'.repeat(64);
const senderPubkey = 'f'.repeat(64);

const block = (text) => ({ type: 'text', text });

// Mirrors Desktop v0.5.26 queue.rs DM reply framing and event headers.
function dmContext({ scopes = ['dm'], replyTo = triggeringEventId } = {}) {
  return block([
    '<context>',
    ...scopes.map((scope) => `Scope: ${scope}`),
    'Session scope: dm conversation',
    `Channel: DM (#${channelId})`,
    'Thread context included below.',
    `Thread root: ${threadRootId}`,
    'IMPORTANT: For ordinary replies in this turn, use `--reply-to ' + replyTo + '` on `buzz messages send` so the conversation stays threaded.',
    '</context>'
  ].join('\n'));
}

function eventBlock({
  eventId = triggeringEventId,
  eventChannelId = channelId,
  content = 'Please answer this DM.',
} = {}) {
  return block([
    '<buzz-event type="@mention">',
    `Event ID: ${eventId}`,
    `Channel: DM (#${eventChannelId})`,
    'Kind: 9',
    `From: Human (npub: npub1example, hex: ${senderPubkey})`,
    'Time: 2026-10-15T12:00:00Z',
    `Content: ${content}`,
    `Tags: [["e","${threadRootId}","","reply"]]`,
    '</buzz-event>'
  ].join('\n'));
}

function dmPrompt(options = {}) {
  return [
    block('<base>Base instructions.</base>'),
    dmContext(options),
    block('<thread-context count="1">Earlier DM message.</thread-context>'),
    eventBlock(options)
  ];
}

test('routes a DM thread reply to the triggering event instead of the thread root', () => {
  assert.deepEqual(parseBuzzContext(dmPrompt()), {
    channelId,
    replyTo: triggeringEventId
  });
});

test('allows a differing reply target only for one DM scope and its matching event', () => {
  const invalidPrompts = [
    dmPrompt({ scopes: ['thread'] }),
    dmPrompt({ scopes: ['dm', 'dm'] }),
    dmPrompt({ replyTo: otherEventId }),
    dmPrompt({ eventChannelId: otherChannelId }),
    [...dmPrompt(), eventBlock({ eventId: otherEventId })],
    dmPrompt({ content: `Please answer.\nEvent ID: ${triggeringEventId}` })
  ];

  for (const prompt of invalidPrompts) {
    assert.equal(parseBuzzContext(prompt), null);
  }
});

test('publishes an ACP DM reply to the validated triggering event', async () => {
  let providerCalls = 0;
  let published;
  let outputText = '';
  const outputMessages = [];
  const output = new PassThrough();
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    outputText += chunk;
    let newline;
    while ((newline = outputText.indexOf('\n')) >= 0) {
      const line = outputText.slice(0, newline);
      outputText = outputText.slice(newline + 1);
      if (line.trim()) outputMessages.push(JSON.parse(line));
    }
  });

  const server = createAcpServer({
    input: new PassThrough(),
    output,
    diagnostics: new PassThrough(),
    ...isolatedServerOptions({
      sessionFactory: () => ({
        prompt: async () => {
          providerCalls += 1;
          return 'DM follow-up answer';
        },
        close() {}
      }),
      publisherFactory: () => ({
        publish: async (request) => {
          published = request;
          return { status: 'sent', eventId: publishedEventId };
        }
      })
    })
  });

  try {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = outputMessages.find((message) => message.id === 2).result.sessionId;

    await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: dmPrompt() }
    });

    const response = outputMessages.find((message) => message.id === 3);
    assert.equal(response?.error?.message, undefined, 'valid DM follow-up should pass context preflight');
    assert.equal(response.result.stopReason, 'end_turn');
    assert.deepEqual(response.result.publication, {
      status: 'sent',
      eventId: publishedEventId
    });
    assert.equal(providerCalls, 1);
    assert.deepEqual(published, {
      channelId,
      replyTo: triggeringEventId,
      content: 'DM follow-up answer'
    });
  } finally {
    await server.close();
  }
});
