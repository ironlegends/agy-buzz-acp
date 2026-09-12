#!/usr/bin/env node
import { runSteeringHook } from '../src/steering.js';
import { boundedByteLimit } from '../src/frame-codec.js';

const maxStdinBytes = boundedByteLimit(process.env.AGY_STEER_HOOK_MAX_STDIN_BYTES);

const chunks = [];
let bytes = 0;
let oversized = false;
for await (const chunk of process.stdin) {
  const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes + part.length > maxStdinBytes) { oversized = true; break; }
  chunks.push(part);
  bytes += part.length;
}

let input = {};
if (oversized) input = null;
else {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks, bytes));
    input = JSON.parse(raw || '{}');
  }
  catch { input = null; }
}

const result = input === null ? {} : await runSteeringHook({ input, env: process.env });
process.stdout.write(`${JSON.stringify(result)}\n`);
