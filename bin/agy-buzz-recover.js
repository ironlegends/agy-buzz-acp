#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
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
  return 'Usage: agy-buzz-recover list --limit <n> [--after <id>] | show <id> | retry <id> | archive-sent --archive-dir <path> [--apply]';
}

function parseListOptions(args) {
  let after = null;
  let limit = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--after' && after === null && index + 1 < args.length) {
      after = args[++index];
      if (!after) throw new Error(usage());
    } else if (flag === '--limit' && limit === null && index + 1 < args.length) {
      const value = args[++index];
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(usage());
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error(usage());
    } else {
      throw new Error(usage());
    }
  }
  if (limit === null) throw new Error(usage());
  return { after, limit };
}

function parseArchiveOptions(args) {
  let archiveDir = null;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--archive-dir' && archiveDir === null && index + 1 < args.length) {
      archiveDir = args[++index];
      if (!archiveDir.trim()) throw new Error(usage());
    } else if (flag === '--apply' && !apply) {
      apply = true;
    } else {
      throw new Error(usage());
    }
  }
  if (archiveDir === null) throw new Error(usage());
  return { archiveDir, dryRun: !apply };
}

function recordSummary(record) {
  return {
    recoveryId: record.recoveryId,
    owner: record.owner,
    channelId: record.channelId,
    replyTo: record.replyTo,
    status: record.status,
    ...(record.eventId ? { eventId: record.eventId } : {})
  };
}

export async function runRecoveryCli(argv, env = process.env, stdout = process.stdout) {
  const [operation, ...args] = argv;
  if (!['list', 'show', 'retry', 'archive-sent'].includes(operation)) throw new Error(usage());
  const options = operation === 'list' ? parseListOptions(args)
    : operation === 'archive-sent' ? parseArchiveOptions(args)
    : null;
  if (options === null && args.length !== 1) throw new Error(usage());

  const outbox = createConfiguredOutbox(env);
  if (outbox.configurationError) throw new Error(outbox.configurationError);
  if (!outbox.enabled) throw new Error('AGY_OUTBOX_DIR and AGY_OUTBOX_OWNER must be configured');
  const owner = await verifyOwner(outbox, env);

  if (operation === 'list') {
    const page = await outbox.listPage(options);
    stdout.write(JSON.stringify({
      records: page.records.map(recordSummary),
      nextCursor: page.nextCursor
    }) + '\n');
    return { status: 'ok', nextCursor: page.nextCursor };
  }

  if (operation === 'archive-sent') {
    const result = await outbox.archiveSent(options);
    stdout.write(JSON.stringify(result) + '\n');
    return result;
  }

  const recoveryId = args[0];
  const record = await outbox.get(recoveryId);
  if (!record) throw new Error('Recovery record not found');
  if (record.owner !== owner) throw new Error('Recovery owner mismatch');
  if (operation === 'show') {
    stdout.write(JSON.stringify(record) + '\n');
    return { status: 'ok' };
  }
  const [command, buzzArgs] = buzzInvocation(env, []);
  const publisher = new BuzzPublisher({ command, prefixArgs: buzzArgs.slice(0, env.BUZZ_FAKE_SCRIPT ? 1 : 0) });
  const result = await outbox.retry(recoveryId, { owner, publish: (request) => publisher.publish(request) });
  stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'blocked' || result.status === 'uncertain' || result.status === 'failed-before-start') {
    throw new Error('Recovery ' + result.status);
  }
  return result;
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntrypoint()) {
  runRecoveryCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write('[agy-buzz-recover] ' + error.message + '\n');
    process.exitCode = 2;
  });
}
