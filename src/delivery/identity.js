import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10000;

function findPubkey(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(value.pubkey)) return value.pubkey.toLowerCase();
  for (const child of Object.values(value)) {
    const found = findPubkey(child);
    if (found) return found;
  }
  return null;
}

export function getBuzzPublicKey({ command = 'buzz', prefixArgs = [], spawnFn = spawn, timeoutMs = COMMAND_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let output = '';
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    try { child = spawnFn(command, [...prefixArgs, '--format', 'json', 'users', 'get'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { finish(new Error('Buzz identity lookup failed to start')); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) {
        try { child.kill(); } catch { /* failure remains bounded */ }
        finish(new Error('Buzz identity lookup output exceeded limit'));
        return;
      }
      output += chunk;
    });
    child.stdout.once('error', () => finish(new Error('Buzz identity lookup failed')));
    child.once('error', () => finish(new Error('Buzz identity lookup failed')));
    child.once('close', (code) => {
      if (code !== 0) { finish(new Error('Buzz identity lookup failed')); return; }
      try {
        const pubkey = findPubkey(JSON.parse(output.trim()));
        if (!pubkey) throw new Error('missing public key');
        finish(null, pubkey);
      } catch { finish(new Error('Buzz identity lookup returned invalid JSON')); }
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* failure remains bounded */ }
      finish(new Error('Buzz identity lookup timed out'));
    }, timeoutMs);
  });
}
