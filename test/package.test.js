import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('packages only the ACP runtime and required documentation', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const compatibilityManifest = JSON.parse(readFileSync(join(root, 'docs/compatibility-manifest.json'), 'utf8'));
  assert.ok(Array.isArray(packageJson.files), 'package.json must define a files allowlist');
  assert.equal(packageJson.version, '0.6.0');
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(compatibilityManifest.candidate.version, packageJson.version);
  assert.equal(compatibilityManifest.nodeSupport.engine, packageJson.engines.node);
  assert.deepEqual(packageJson.files, [
    'bin/agy-buzz-acp.js',
    'bin/agy-buzz-recover.js',
    'bin/agy-buzz-doctor.js',
    'bin/agy-buzz-steer-hook.js',
    'src/acp-server.js',
    'src/agy-session.js',
    'src/frame-codec.js',
    'src/prompt.js',
    'src/buzz-context.js',
    'src/buzz-publisher.js',
    'src/delivery/outbox.js',
    'src/native-lock.js',
    'src/delivery/identity.js',
    'src/doctor.js',
    'docs/COMPATIBILITY.md',
    'docs/compatibility-manifest.json',
    'docs/PROTOCOL_LIMITS.md',
    'docs/DIAGNOSTICS.md',
    'docs/OFFICIAL_BUZZ_RECOVERY.md',
    'docs/UPGRADING.md',
    'docs/MANAGER_RECOVERY.md',
    'docs/OUTBOX_COMPATIBILITY.md',
    'docs/MIGRATING_04_TO_05.md',
    'examples',
    'README.md',
    'src/session-state.js',
    'LICENSE',
    'CONTRIBUTING.md',
    'src/models.js',
    'src/executables.js',
    'src/setup.js',
    'bin/agy-buzz-manage.js',
    'src/manage.js',
    'src/status.js',
    'src/steering-diagnostics.js',
    'src/steering.js'
  ]);
  const files = new Set(packageJson.files);
  assert.deepEqual(packageJson.dependencies, { 'fs-native-extensions': '1.5.1', 'bare-url': '2.5.5' });
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
  assert.deepEqual(packageLock.packages[''].bundleDependencies, packageJson.bundledDependencies);
  assert.deepEqual(packageJson.bundledDependencies, [
    'fs-native-extensions', 'require-addon', 'bare-addon-resolve', 'bare-module-resolve', 'bare-semver', 'which-runtime',
    'bare-url', 'bare-path'
  ]);
  for (const dependency of packageJson.bundledDependencies) {
    const entry = packageLock.packages[`node_modules/${dependency}`];
    assert.ok(entry, `${dependency} must be present in the locked graph`);
    assert.equal(entry.inBundle, true, `${dependency} must be marked for bundling in the lockfile`);
    assert.equal(entry.license, 'Apache-2.0', `${dependency} license metadata must be preserved`);
  }
  for (const excluded of [
    'fixtures/fake-buzz.js',
    'test/fixtures/fake-buzz.js',
    'test',
    'docs',
    'docs/superpowers',
    'docs/RECOVERY_DESIGN.md'
  ]) {
    assert.equal(files.has(excluded), false, `${excluded} must stay out of the package`);
  }
  for (const required of [
    'bin/agy-buzz-acp.js',
    'bin/agy-buzz-recover.js',
    'bin/agy-buzz-doctor.js',
    'bin/agy-buzz-steer-hook.js',
    'src/acp-server.js',
    'src/agy-session.js',
    'src/frame-codec.js',
    'src/prompt.js',
    'src/doctor.js',
    'src/steering-diagnostics.js',
    'src/steering.js',
    'docs/COMPATIBILITY.md',
    'docs/compatibility-manifest.json',
    'docs/PROTOCOL_LIMITS.md',
    'docs/DIAGNOSTICS.md',
    'docs/OFFICIAL_BUZZ_RECOVERY.md',
    'docs/UPGRADING.md',
    'docs/MANAGER_RECOVERY.md',
    'docs/OUTBOX_COMPATIBILITY.md',
    'docs/MIGRATING_04_TO_05.md',
    'README.md',
    'examples'
  ]) {
    assert.equal(files.has(required), true, `${required} must be packaged`);
  }
});
