#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createConfiguredSessionState } from '../src/session-state.js';
import { migrateLegacySessionState } from '../src/session-state-migration.js';

const usage = `Usage: agy-buzz-state --source <legacy-dir> --destination <absent-dir> [--apply]

Validates a legacy session-state store without changing it by default. --apply
stages a complete canonical copy beside the destination and publishes it only
after validation. All old writers must be stopped. The source remains unchanged.

Configuration comes from AGY_SESSION_OWNER and BUZZ_RELAY_URL (or AGY_RELAY_URL).
`;

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      source: { type: 'string' },
      destination: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    },
    strict: true,
    allowPositionals: true
  });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    if (positionals.length || !values.source || !values.destination) {
      throw Object.assign(new Error('source and destination are required'), { code: 'AGY_STATE_MIGRATION_ARGUMENT' });
    }
    const sourceDir = resolve(values.source);
    const destinationDir = resolve(values.destination);
    const configured = createConfiguredSessionState({ ...process.env, AGY_SESSION_DIR: sourceDir,
      BUZZ_RELAY_URL: process.env.BUZZ_RELAY_URL ?? process.env.AGY_RELAY_URL });
    if (configured.configurationError || !configured.enabled) {
      throw Object.assign(new Error(configured.configurationError ?? 'session owner and relay are required'),
        { code: 'AGY_STATE_MIGRATION_ARGUMENT' });
    }
    const result = await migrateLegacySessionState({
      sourceDir,
      destinationDir,
      owner: configured.owner,
      relay: process.env.BUZZ_RELAY_URL ?? process.env.AGY_RELAY_URL,
      apply: values.apply
    });
    const state = result.applied ? 'published' : 'validated; no destination published';
    process.stdout.write(`${state}: ${result.recordCount} records, ${result.blockedCount} blocked\n`);
  }
} catch (error) {
  process.stderr.write(`agy-buzz-state: ${error.message}\n`);
  if (error.stagedPath) process.stderr.write(`Incomplete stage retained for inspection: ${error.stagedPath}\n`);
  if (error.published) process.stderr.write('The complete destination was published; inspect it before any retry.\n');
  process.exitCode = 1;
}
