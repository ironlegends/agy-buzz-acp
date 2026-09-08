import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = 30000;
const safeEnvironment = Object.fromEntries(
  ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]])
);

function runNode(packageRoot, entry, args = [], input = '', envOverrides = {}) {
  const result = spawnSync(process.execPath, [join(packageRoot, entry), ...args], {
    cwd: packageRoot,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...safeEnvironment, ...envOverrides },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result;
}

function runNpmPack(tempRoot, destinationName) {
  const args = ['pack', '--ignore-scripts', '--pack-destination', destinationName, '--json'];
  if (process.platform !== 'win32') {
    return spawnSync('npm', args, {
      cwd: repositoryRoot, encoding: 'utf8', timeout: timeoutMs, env: { ...safeEnvironment, NPM_CONFIG_CACHE: join(tempRoot, 'npm-cache') }, shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  const commandLine = ['npm', 'pack', '--ignore-scripts', '--pack-destination', destinationName, '--json'].join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: timeoutMs, env: { ...safeEnvironment, NPM_CONFIG_CACHE: join(tempRoot, 'npm-cache') }, shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function main() {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'agy-buzz-acp-package-smoke-')));
  const packDestination = await mkdtemp(join(repositoryRoot, '.package-smoke-'));
  const packDestinationName = basename(packDestination);
  const packageRoot = join(tempRoot, 'package');
  try {
    const packed = runNpmPack(tempRoot, packDestinationName);
    assert.equal(packed.status, 0, `npm pack failed with status ${packed.status}`);
    const metadata = JSON.parse(packed.stdout.trim());
    const archive = join(packDestination, basename(metadata[0].filename));
    const extracted = spawnSync('tar', ['-xf', archive, '-C', tempRoot], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: safeEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(extracted.status, 0, `archive extraction failed with status ${extracted.status}`);
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, metadata[0].version);

    // Exercise the extracted native binding without npm install or repository
    // module resolution. Merely loading the ACP command is not a lock test.
    const nativeProbe = join(tempRoot, 'native-check.mjs');
    await writeFile(nativeProbe, `
      import assert from 'node:assert/strict';
      import { acquireNativeLock } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'src/native-lock.js')).href)};
      const path = ${JSON.stringify(join(tempRoot, 'packaged.lock'))};
      const first = await acquireNativeLock(path);
      await assert.rejects(acquireNativeLock(path));
      await first.release();
      const second = await acquireNativeLock(path);
      await second.release();
    `);
    const nativeCheck = runNode(packageRoot, '../native-check.mjs');
    assert.equal(nativeCheck.status, 0, `packaged native lock failed with status ${nativeCheck.status}`);

    const handshake = runNode(packageRoot, 'bin/agy-buzz-acp.js', [], `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 }
    })}\n`);
    assert.equal(handshake.status, 0, `ACP initialize failed with status ${handshake.status}`);
    const response = JSON.parse(handshake.stdout.trim());
    assert.equal(response.result.protocolVersion, 1);
    assert.equal(response.result.agentInfo.version, packageJson.version,
      `expected integration dependency: acp-server agentInfo.version must match package version ${packageJson.version}`);

    const doctorVersion = runNode(packageRoot, 'bin/agy-buzz-doctor.js', ['--version']);
    assert.equal(doctorVersion.status, 0, 'doctor --version failed');
    assert.equal(doctorVersion.stdout.trim(), packageJson.version);
    const doctorHelp = runNode(packageRoot, 'bin/agy-buzz-doctor.js', ['--help']);
    assert.equal(doctorHelp.status, 0, 'doctor --help failed');
    assert.match(doctorHelp.stdout, /Usage: agy-buzz-doctor/);

    const recovery = runNode(packageRoot, 'bin/agy-buzz-recover.js');
    assert.equal(recovery.status, 2, 'recovery usage smoke should fail closed with status 2');
    assert.match(recovery.stderr, /Usage: agy-buzz-recover/);

    const setup = runNode(packageRoot, 'bin/agy-buzz-acp.js', ['setup'], '', {
      AGY_COMMAND: process.execPath, BUZZ_CLI_COMMAND: process.execPath
    });
    assert.equal(setup.status, 0, 'packaged setup command failed');
    const harness = JSON.parse(setup.stdout);
    assert.equal(harness.command, process.execPath);
    assert.equal(harness.args.length, 1);
    assert.equal(await realpath(harness.args[0]), await realpath(join(packageRoot, 'bin', 'agy-buzz-acp.js')));

    const fakeModels = join(tempRoot, 'fake-models.cjs');
    await writeFile(fakeModels, "process.stdout.write('fixture-model\\tFixture Model\\n');\n");
    const models = runNode(packageRoot, 'bin/agy-buzz-acp.js', ['models'], '', {
      AGY_COMMAND: process.execPath, AGY_FAKE_SCRIPT: fakeModels, AGY_MODEL: 'fixture-model'
    });
    assert.equal(models.status, 0, 'packaged model catalog command failed');
    const catalog = JSON.parse(models.stdout);
    assert.equal(catalog.stable.configOptions[0].category, 'model');
    assert.equal(catalog.unstable.availableModels[0].modelId, 'fixture-model');

    const harnessFile = join(tempRoot, 'harness.json');
    const harnessBytes = JSON.stringify(harness, null, 2);
    await writeFile(harnessFile, harnessBytes);
    const configuredDoctor = runNode(packageRoot, 'bin/agy-buzz-doctor.js', ['--harness', harnessFile, '--json']);
    assert.equal(configuredDoctor.status, 0, 'packaged harness diagnostic failed');
    const configuredReport = JSON.parse(configuredDoctor.stdout);
    assert.equal(configuredReport.harness.adapter.configuredVersion, packageJson.version);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const installArgs = ['install', '--archive', archive, '--sha256', digest,
      '--root', join(tempRoot, 'runtime'), '--harness', harnessFile];
    const installPlan = runNode(packageRoot, 'bin/agy-buzz-manage.js', installArgs);
    assert.equal(installPlan.status, 0, `packaged install planning failed: ${installPlan.stderr}`);
    assert.equal(await readFile(harnessFile, 'utf8'), harnessBytes, 'planning changed the harness');
    const installed = runNode(packageRoot, 'bin/agy-buzz-manage.js', [...installArgs, '--apply']);
    assert.equal(installed.status, 0, 'packaged install failed');
    const installedReport = JSON.parse(installed.stdout);
    const rollback = runNode(packageRoot, 'bin/agy-buzz-manage.js', [
      'rollback', '--backup', installedReport.backupPath, '--harness', harnessFile, '--apply'
    ]);
    assert.equal(rollback.status, 0, 'packaged rollback failed');
    assert.equal(await readFile(harnessFile, 'utf8'), harnessBytes, 'rollback did not restore the original configuration');
    console.log(JSON.stringify({ package: packageJson.name, version: packageJson.version,
      archive: 'extracted', handshake: 'PASS', doctor: 'PASS', recovery: 'PASS', setup: 'PASS', models: 'PASS', manage: 'PASS',
      nativeLock: 'PASS', providerCalls: 0, publications: 0 }));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(packDestination, { recursive: true, force: true });
  }
}

await main();
