import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const marker = (phase) => `AGY_STEERING_ACL_PHASE=${phase}`;

test('Windows ACL diagnostics expose only bounded categories and phases', async () => {
  const { formatWindowsAclFailureMessage } = await import('../src/steering.js');
  assert.equal(typeof formatWindowsAclFailureMessage, 'function');

  const error = Object.assign(new Error('C:\\Users\\private\\secret SID S-1-5-21-123456'), {
    code: 'ETIMEDOUT',
    stderr: [
      marker('script-enter'),
      'SyntheticAccount at C:\\Users\\private\\secret SID S-1-5-21-123456',
      marker('rules-read-start'),
      marker('not-a-real-phase')
    ].join('\r\n')
  });

  assert.equal(formatWindowsAclFailureMessage(error),
    'agy steering Windows ACL inspection failed (category: timeout, phase: rules-read-start)');
  const boundedChildError = Object.assign(new Error('C:\\Users\\private\\secret'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
    stderr: marker('acl-read-start')
  });
  assert.equal(formatWindowsAclFailureMessage(boundedChildError),
    'agy steering Windows ACL inspection failed (category: terminated, phase: acl-read-start)');
  assert.equal(formatWindowsAclFailureMessage(Object.assign(new Error('private details'), {
    code: 'private-category',
    stderr: marker('not-a-real-phase')
  })), 'agy steering Windows ACL inspection failed (category: process-failed, phase: unknown)');
});

test('Windows ACL diagnostics identify JSON parsing failures without including parser text', async () => {
  const { formatWindowsAclFailureMessage } = await import('../src/steering.js');
  assert.equal(typeof formatWindowsAclFailureMessage, 'function');

  const error = Object.assign(new SyntaxError('Unexpected token from C:\\Users\\private\\secret'), {
    stderr: `${marker('json-start')}\r\n${marker('json-end')}`
  });
  assert.equal(formatWindowsAclFailureMessage(error),
    'agy steering Windows ACL inspection failed (category: invalid-output, phase: json-end)');
});

test('the native Windows ACL reader accepts its protected directory using SID identities', { skip: process.platform !== 'win32' }, async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agy-windows-acl-'));
  t.after(async () => { await rm(rootDir, { recursive: true, force: true }); });

  const { createSteeringCoordinator } = await import('../src/steering.js');
  const options = {
    rootDir,
    ownerId: 'ab'.repeat(32),
    channelId: '123e4567-e89b-12d3-a456-426614174000',
    sessionId: 'windows_acl_test',
    conversationId: '188e2ee5-9c44-4d95-bdd5-23eeb2d93e47',
    injectorExclusive: true,
    hookConfigured: true
  };
  const created = await createSteeringCoordinator(options);
  const reopened = await createSteeringCoordinator({ ...options, bridgeDir: created.bridgeDir });
  assert.equal(reopened.enabled, true);
});
