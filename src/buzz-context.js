const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EVENT_ID = '[0-9a-f]{64}';
const BASE_MARKER = /^\[Base\](?:\s|$)/;
const CONTEXT_MARKER = /^\[Context\](?:\s|$)/;
const XML_BASE_MARKER = /^<base(?:\s[^<>]*)?>/i;
const XML_CONTEXT_MARKER = /^<context(?:\s[^<>]*)?>/i;
const XML_EVENT_MARKER = /^<buzz-event(?:\s[^<>]*)?>/i;

function isBaseBlock(text) {
  return BASE_MARKER.test(text) || XML_BASE_MARKER.test(text);
}

function isContextBlock(text) {
  return CONTEXT_MARKER.test(text) || XML_CONTEXT_MARKER.test(text);
}

// Fallback destination for a top-level channel prompt, whose context block carries
// neither `Thread root:` nor `--reply-to`. Only the envelope header may name a
// destination: every line from the first `Content:` down is sender controlled, so a
// forged `Event ID:` there raises the match count and the fallback refuses instead.
function eventDestination(prompt, channelId) {
  const indexes = prompt
    .map((block, index) => XML_EVENT_MARKER.test(block.text) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length !== 1) return null;
  const eventText = prompt[indexes[0]].text
    .replace(XML_EVENT_MARKER, '')
    .replace(/<\/buzz-event>\s*$/i, '');
  // No `Content:` line means no boundary between the envelope header and text the
  // sender wrote, so there is nothing to trust: refuse instead of reading it all.
  const contentIndex = eventText.search(/^Content:/m);
  if (contentIndex < 0) return null;
  const headerLength = contentIndex;
  const eventMatches = [...eventText.matchAll(new RegExp('^Event ID:\\s*(' + EVENT_ID + ')\\s*$', 'gmi'))];
  if (eventMatches.length !== 1 || eventMatches[0].index >= headerLength) return null;
  const header = eventText.slice(0, headerLength);
  const channelMatches = [...header.matchAll(new RegExp('^Channel:[^\\r\\n]*?(' + UUID + ')[^\\r\\n]*$', 'gmi'))];
  if (channelMatches.length !== 1 || channelMatches[0][1].toLowerCase() !== channelId.toLowerCase()) return null;
  return eventMatches[0][1];
}

export function parseBuzzContext(prompt) {
  if (!Array.isArray(prompt) || prompt.length < 2 || prompt.some((block) => !block || block.type !== 'text' || typeof block.text !== 'string')) return null;
  if (!isBaseBlock(prompt[0].text) && !isContextBlock(prompt[0].text)) return null;
  const contextIndexes = prompt
    .map((block, index) => isContextBlock(block.text) ? index : -1)
    .filter((index) => index >= 0);
  // Only a unique block at a trusted ACP boundary may carry routing. The other
  // blocks can be reordered, renamed, interrupted, or rewritten freely.
  if (contextIndexes.length !== 1) return null;
  const contextText = prompt[contextIndexes[0]].text
    .replace(XML_CONTEXT_MARKER, '')
    .replace(/<\/context>\s*$/, '');
  const channelMatches = [...contextText.matchAll(new RegExp('^Channel:\\s*[^\\r\\n]*\\(#?(' + UUID + ')\\)\\s*$', 'gmi'))];
  if (channelMatches.length !== 1) return null;
  const rootMatches = [...contextText.matchAll(new RegExp('^Thread root:\\s*(' + EVENT_ID + ')\\s*$', 'gmi'))];
  const replyToMatches = [...contextText.matchAll(new RegExp('--reply-to\\s+(' + EVENT_ID + ')', 'gmi'))];
  const uniqueReplyTos = [...new Set(replyToMatches.map((m) => m[1]))];
  let replyTo;
  if (rootMatches.length === 1) {
    replyTo = rootMatches[0][1];
    if (uniqueReplyTos.length > 0 && (uniqueReplyTos.length > 1 || uniqueReplyTos[0] !== replyTo)) return null;
  } else if (rootMatches.length === 0) {
    if (uniqueReplyTos.length > 1) return null;
    replyTo = uniqueReplyTos[0] ?? eventDestination(prompt, channelMatches[0][1]);
    if (!replyTo) return null;
  } else {
    return null;
  }
  return { channelId: channelMatches[0][1], replyTo };
}
