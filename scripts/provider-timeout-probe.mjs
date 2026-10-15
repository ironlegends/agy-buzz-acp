import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--command' || !isAbsolute(args[1])) {
  process.stderr.write('Usage: node scripts/provider-timeout-probe.mjs --command /absolute/path/to/agy\n');
  process.exitCode = 2;
} else {
  const command = args[1];
  const hash = async () => createHash('sha256').update(await readFile(command)).digest('hex');
  const binarySha256 = await hash();
  const version = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, shell: false });
  assert.equal(version.status, 0, 'provider version probe failed');
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'agy-timeout-probe-')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGY_|BUZZ_)/i.test(key)));
  const started = Date.now(), events = new Set();
  let buffer = '', forced = false, stdoutBytes = 0, stderrBytes = 0;
  const child = spawn(command, ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--sandbox', '--print-timeout', '2s', '--log-file', join(cwd, 'probe.log')],
  { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length; buffer += chunk;
    for (;;) {
      const n = buffer.indexOf('\n'); if (n < 0) break;
      try { events.add(JSON.parse(buffer.slice(0, n)).event); } catch {}
      buffer = buffer.slice(n + 1);
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const timer = setTimeout(() => { forced = true; child.kill(); }, 8000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(await hash(), binarySha256, 'provider binary changed during probe');
    console.log(JSON.stringify({ providerVersion: version.stdout.trim(), binarySha256, probe: 'idle-open-stdin-2s',
      elapsedMs: Date.now() - started, forced, ...result, stdoutBytes, stderrBytes,
      events: [...events], providerPrompts: 0, realPublications: 0 }));
  } finally { clearTimeout(timer); await rm(cwd, { recursive: true, force: true }); }
}
