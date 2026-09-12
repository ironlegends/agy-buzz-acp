import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { getBuzzPublicKey } from '../src/delivery/identity.js';

function child() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.killed = false;
  process.kill = () => { process.killed = true; };
  return process;
}
const owner = 'ab'.repeat(32);

test('identity uses only the supplied launcher and explicit no-shell arguments', async () => {
  const process = child();
  let calls = 0;
  const pending = getBuzzPublicKey({ command: 'synthetic-command', prefixArgs: ['fixture'],
    spawnFn(command, args, options) {
      calls++;
      assert.equal(command, 'synthetic-command');
      assert.deepEqual(args, ['fixture', '--format', 'json', 'users', 'get']);
      assert.deepEqual(options, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      return process;
    } });
  process.stdout.write(JSON.stringify({ pubkey: owner }));
  process.emit('close', 0);
  assert.equal(await pending, owner);
  assert.equal(calls, 1);
});
test('injected launcher failure does not fall back to a real executable', async () => {
  let calls = 0;
  await assert.rejects(getBuzzPublicKey({ command: 'must-not-run', spawnFn() {
    calls++; throw new Error('synthetic sensitive launcher detail');
  } }), { message: 'Buzz identity lookup failed to start' });
  assert.equal(calls, 1);
});
test('injected identity child output remains bounded', async () => {
  const process = child();
  const pending = getBuzzPublicKey({ spawnFn: () => process, maxOutputBytes: 8 });
  process.stdout.write('oversized synthetic output');
  await assert.rejects(pending, /output exceeded limit/);
  assert.equal(process.killed, true);
});
test('injected identity child timeout remains bounded', async () => {
  const process = child();
  await assert.rejects(getBuzzPublicKey({ spawnFn: () => process, timeoutMs: 10 }), /timed out/);
  assert.equal(process.killed, true);
});
test('injected child failure is reported without raw exception text', async () => {
  const process = child();
  const pending = getBuzzPublicKey({ spawnFn: () => process });
  process.emit('error', new Error('synthetic sensitive detail'));
  await assert.rejects(pending, { message: 'Buzz identity lookup failed' });
});
test('injected identity child malformed output does not select an identity', async () => {
  const process = child();
  const pending = getBuzzPublicKey({ spawnFn: () => process });
  process.stdout.write('{'); process.emit('close', 0);
  await assert.rejects(pending, { message: 'Buzz identity lookup returned invalid JSON' });
});

test('identity refuses distinct nested public keys instead of selecting the first', async () => {
  const process = child();
  const pending = getBuzzPublicKey({ spawnFn: () => process });
  process.stdout.write(JSON.stringify({ identities: [{ pubkey: owner }, { pubkey: 'cd'.repeat(32) }] }));
  process.emit('close', 0);
  await assert.rejects(pending, /ambiguous|multiple public keys/i);
});
