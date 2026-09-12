// Incremental NDJSON framing: one reusable, capped byte buffer per decoder.
// UTF-8 is decoded only at a newline; malformed sequences are never replaced.
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_DEFERRED_EVENTS = 1024;
export const FRAME_TOO_LARGE = 'FRAME_TOO_LARGE';
export const FRAME_TRUNCATED = 'FRAME_TRUNCATED';
export const FRAME_INVALID_UTF8 = 'FRAME_INVALID_UTF8';

function finiteInteger(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return NaN;
}

export function boundedByteLimit(value, fallback = DEFAULT_MAX_FRAME_BYTES) {
  const defaultValue = Number.isSafeInteger(fallback) && fallback > 0
    ? Math.min(fallback, DEFAULT_MAX_FRAME_BYTES) : DEFAULT_MAX_FRAME_BYTES;
  const candidate = finiteInteger(value);
  return Number.isSafeInteger(candidate) && candidate > 0
    ? Math.min(candidate, DEFAULT_MAX_FRAME_BYTES) : defaultValue;
}

export function boundedEventLimit(value, fallback = DEFAULT_MAX_DEFERRED_EVENTS) {
  const defaultValue = Number.isSafeInteger(fallback) && fallback > 0
    ? Math.min(fallback, DEFAULT_MAX_DEFERRED_EVENTS) : DEFAULT_MAX_DEFERRED_EVENTS;
  const candidate = finiteInteger(value);
  return Number.isSafeInteger(candidate) && candidate > 0
    ? Math.min(candidate, DEFAULT_MAX_DEFERRED_EVENTS) : defaultValue;
}

export function resolveFrameLimits(limits = {}) {
  const options = limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : {};
  return {
    maxFrameBytes: boundedByteLimit(options.maxFrameBytes),
    maxResponseBytes: boundedByteLimit(options.maxResponseBytes),
    maxDeferredBytes: boundedByteLimit(options.maxDeferredBytes),
    maxDeferredEvents: boundedEventLimit(options.maxDeferredEvents)
  };
}

export function validateByteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_FRAME_BYTES) {
    throw new TypeError('byte limit must be an integer between 1 and 8 MiB');
  }
  return value;
}

export function createLineDecoder({ maxLineBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  validateByteLimit(maxLineBytes);
  let storage = Buffer.allocUnsafe(Math.min(1024, maxLineBytes));
  let length = 0;
  let overflow = false;
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const error = (code, message) => ({ error: { code, message } });

  function accumulate(part, results) {
    if (overflow || part.length === 0) return;
    const needed = length + part.length;
    if (needed > maxLineBytes) {
      length = 0;
      overflow = true;
      results.push(error(FRAME_TOO_LARGE, 'line exceeds the byte limit'));
      return;
    }
    if (needed > storage.length) {
      const next = Buffer.allocUnsafe(Math.min(maxLineBytes, Math.max(needed, storage.length * 2)));
      storage.copy(next, 0, 0, length);
      storage = next;
    }
    part.copy(storage, length);
    length = needed;
  }

  function push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const results = [];
    let offset = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) { accumulate(bytes.subarray(offset), results); break; }
      accumulate(bytes.subarray(offset, newline), results);
      if (!overflow) {
        try { results.push({ line: utf8.decode(storage.subarray(0, length)) }); }
        catch { results.push(error(FRAME_INVALID_UTF8, 'line contains invalid UTF-8')); }
      }
      length = 0;
      overflow = false;
      offset = newline + 1;
    }
    return results;
  }

  function finish() {
    if (length !== 0 && !overflow) {
      try { utf8.decode(storage.subarray(0, length)); }
      catch {
        length = 0;
        overflow = false;
        return error(FRAME_INVALID_UTF8, 'line contains invalid UTF-8');
      }
    }
    const truncated = length !== 0 && !overflow;
    length = 0;
    overflow = false;
    return truncated ? error(FRAME_TRUNCATED, 'stream ended before a final newline') : null;
  }
  return { push, finish, get retainedCapacity() { return storage.length; } };
}

export function attachLineDecoder(stream, { maxLineBytes = DEFAULT_MAX_FRAME_BYTES, onLine, onError } = {}) {
  const decoder = createLineDecoder({ maxLineBytes });
  stream.on('data', (chunk) => {
    for (const result of decoder.push(chunk)) {
      if (result.error) onError?.(result.error);
      else onLine?.(result.line);
    }
  });
  stream.on('end', () => {
    const truncated = decoder.finish();
    if (truncated) onError?.(truncated.error);
  });
}

export function createByteBudget(maxBytes = DEFAULT_MAX_FRAME_BYTES) {
  validateByteLimit(maxBytes);
  let total = 0;
  return {
    add(text) {
      total = Math.min(maxBytes + 1, total + Buffer.byteLength(text, 'utf8'));
      return total <= maxBytes;
    },
    get bytes() { return total; }
  };
}
