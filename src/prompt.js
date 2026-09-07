export function promptToText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new TypeError('prompt must contain at least one text block');
  }
  return prompt.map((block) => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      throw new TypeError('only ACP text prompt blocks are supported');
    }
    return block.text;
  }).join('');
}
