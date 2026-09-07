import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('packages only the ACP runtime and required documentation', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(packageJson.files), 'package.json must define a files allowlist');
  assert.deepEqual(packageJson.files, [
    'bin/agy-buzz-acp.js',
    'bin/agy-buzz-recover.js',
    'bin/agy-buzz-doctor.js',
    'src/acp-server.js',
    'src/agy-session.js',
    'src/prompt.js',
    'src/buzz-context.js',
    'src/buzz-publisher.js',
    'src/delivery/outbox.js',
    'src/delivery/identity.js',
    'src/doctor.js',
    'docs',
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
    'src/status.js'
  ]);
  const files = new Set(packageJson.files);
  for (const excluded of ['fixtures/fake-buzz.js', 'test/fixtures/fake-buzz.js', 'test']) {
    assert.equal(files.has(excluded), false, `${excluded} must stay out of the package`);
  }
  for (const required of ['bin/agy-buzz-acp.js', 'bin/agy-buzz-recover.js', 'bin/agy-buzz-doctor.js', 'src/acp-server.js', 'src/agy-session.js', 'src/prompt.js', 'src/doctor.js', 'README.md', 'examples']) {
    assert.equal(files.has(required), true, `${required} must be packaged`);
  }
});
