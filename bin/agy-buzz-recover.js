#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { BuzzPublisher } from '../src/buzz-publisher.js';
import { createConfiguredOutbox } from '../src/delivery/outbox.js';
import { getBuzzPublicKey } from '../src/delivery/identity.js';

function buzzInvocation(env, args) {
  const prefixArgs = env.BUZZ_FAKE_SCRIPT ? [env.BUZZ_FAKE_SCRIPT] : [];
  return [env.BUZZ_CLI_COMMAND || 'buzz', [...prefixArgs, ...args]];
}

async function verifyOwner(outbox, env) {
  const [command, args] = buzzInvocation(env, ['--format', 'json', 'users', 'get']);
  const actual = await getBuzzPublicKey({ command, prefixArgs: args.slice(0, env.BUZZ_FAKE_SCRIPT ? 1 : 0) });
  if (!actual || actual !== outbox.owner) throw new Error('Buzz identity does not match AGY_OUTBOX_OWNER');
  return actual;
}

function usage() {
  return 'Usage: agy-buzz-recover <list|show|retry> [recovery-id]';
}

export async function runRecoveryCli(argv, env = process.env, stdout = process.stdout) {
  const [operation, recoveryId] = argv;
  if (!['list', 'show', 'retry'].includes(operation) || (operation !== 'list' && !recoveryId)) throw new Error(usage());
  const outbox = createConfiguredOutbox(env);
  if (outbox.configurationError) throw new Error(outbox.configurationError);
  if (!outbox.enabled) throw new Error('AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER must be configured');
  const owner = await verifyOwner(outbox, env);
  if (operation === 'list') {
    const records = await outbox.list();
    stdout.write(`${JSON.stringify(records.map(({ recoveryId: id, owner: recordOwner, channelId, replyTo, status, eventId }) => ({ recoveryId: id, owner: recordOwner, channelId, replyTo, status, ...(eventId ? { eventId } : {}) })))}\n`);
    return { status: 'ok' };
  }
  const record = await outbox.get(recoveryId);
  if (!record) throw new Error('Recovery record not found');
  if (record.owner !== owner) throw new Error('Recovery owner mismatch');
  if (operation === 'show') {
    stdout.write(`${JSON.stringify(record)}\n`);
    return { status: 'ok' };
  }
  const [command, args] = buzzInvocation(env, []);
  const publisher = new BuzzPublisher({ command, prefixArgs: args.slice(0, env.BUZZ_FAKE_SCRIPT ? 1 : 0) });
  const result = await outbox.retry(recoveryId, { owner, publish: (request) => publisher.publish(request) });
  stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'blocked' || result.status === 'uncertain' || result.status === 'failed-before-start') throw new Error(`Recovery ${result.status}`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRecoveryCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[agy-buzz-recover] ${error.message}\n`);
    process.exitCode = 2;
  });
}
