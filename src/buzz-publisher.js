import { spawn } from 'node:child_process';

export class BuzzPublisher {
  constructor({ command = 'buzz', prefixArgs = [], spawnFn = spawn, timeoutMs = 30000, maxOutputBytes = 64 * 1024 } = {}) {
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  publish({ channelId, replyTo, content }, signal) {
    const args = ['messages', 'send', '--channel', channelId, '--reply-to', replyTo, '--content', '-'];
    if (signal?.aborted) return Promise.resolve({ status: 'uncertain', code: 'CANCELLED' });
    return new Promise((resolve) => {
      let child;
      let processStarted = false;
      let settled = false;
      let output = '';
      let outputBytes = 0;
      let timer;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve(result);
      };
      const onAbort = () => {
        try { child?.kill(); } catch { /* cancellation remains authoritative */ }
        finish({ status: 'uncertain', code: 'CANCELLED' });
      };
      try {
        child = this.spawnFn(this.command, [...this.prefixArgs, ...args], {
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore']
        });
      } catch {
        finish({ status: 'failed-before-start' });
        return;
      }
      child.once('spawn', () => { processStarted = true; });
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        if (settled) return;
        const text = String(chunk);
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > this.maxOutputBytes) {
          try { child.kill(); } catch { /* result remains uncertain */ }
          finish({ status: 'uncertain' });
          return;
        }
        output += text;
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* result remains uncertain */ }
        finish({ status: 'uncertain' });
      }, this.timeoutMs);
      child.stdin?.once?.('error', () => {
        try { child.kill(); } catch { /* result remains uncertain */ }
        finish({ status: 'uncertain' });
      });
      child.once('error', () => finish({ status: processStarted ? 'uncertain' : 'failed-before-start' }));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({ status: 'uncertain' });
          return;
        }
        let ack;
        try { ack = JSON.parse(output.trim()); } catch { finish({ status: 'uncertain' }); return; }
        if (ack?.accepted !== true || typeof ack.event_id !== 'string' || !/^[0-9a-f]{64}$/i.test(ack.event_id)) {
          finish({ status: 'uncertain' });
          return;
        }
        finish({ status: 'sent', eventId: ack.event_id.toLowerCase() });
      });
      try {
        child.stdin.write(content);
        child.stdin.end();
      } catch {
        finish({ status: 'uncertain' });
      }
    });
  }
}
