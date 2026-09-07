#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const usage = 'Usage: agy-buzz-acp [models|setup|--help|--version]';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`${usage}\nNo arguments: start ACP stdio.\nmodels: query the provider catalog.\nsetup: print a custom harness configuration without writing files.\n`);
    return;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (args.length > 1 || (args.length === 1 && !['models', '--models', 'setup'].includes(args[0]))) {
    throw new Error(usage);
  }
  const { resolveExecutable } = await import('../src/executables.js');
  if (args[0] === 'setup') {
    const { buildHarnessConfig } = await import('../src/setup.js');
    const config = await buildHarnessConfig({ env: process.env, adapterPath: fileURLToPath(import.meta.url), nodePath: process.execPath });
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (args[0] === 'models' || args[0] === '--models') {
    const { listModels, modelConfigOptions } = await import('../src/models.js');
    const agy = await resolveExecutable({ name: 'agy', env: process.env });
    if (!agy) throw new Error('Antigravity executable not found; run setup or configure AGY_COMMAND');
    const models = await listModels({ command: agy.path, cwd: process.cwd(),
      prefixArgs: process.env.AGY_FAKE_SCRIPT ? [process.env.AGY_FAKE_SCRIPT] : [] });
    const currentModelId = process.env.AGY_MODEL || 'gemini-3.8-flash-high';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(currentModelId)) throw new Error('AGY_MODEL must be a valid model identifier');
    process.stdout.write(`${JSON.stringify({ agent: { name: 'agy-buzz-acp', version },
      stable: { configOptions: modelConfigOptions(models, currentModelId) },
      unstable: { currentModelId, availableModels: models } })}\n`);
    return;
  }
  const [agy, buzz] = await Promise.all([
    resolveExecutable({ name: 'agy', env: process.env }),
    resolveExecutable({ name: 'buzz', env: process.env })
  ]);
  if (agy) process.env.AGY_COMMAND = agy.path;
  if (buzz) process.env.BUZZ_CLI_COMMAND = buzz.path;
  const { createAcpServer } = await import('../src/acp-server.js');
  createAcpServer();
}

main().catch((error) => {
  process.stderr.write(`[agy-buzz-acp] ${error.message}\n`);
  process.exitCode = 2;
});
