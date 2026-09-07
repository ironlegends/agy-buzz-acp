import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutable } from '../src/executables.js';

function fakeFs(existing, calls = []) {
  return {
    stat: async (candidate) => {
      calls.push(['stat', candidate]);
      if (!existing.has(candidate)) throw new Error('missing');
      return { isFile: () => true };
    },
    access: async (candidate, mode) => {
      calls.push(['access', candidate, mode]);
      if (!existing.has(candidate)) throw new Error('missing');
    }
  };
}

test('explicit executable variables take priority over PATH', async () => {
  const explicit = 'C:\\tools with spaces\\agy.exe';
  const pathCandidate = 'C:\\path\\agy.exe';
  const calls = [];
  const result = await resolveExecutable({
    name: 'agy',
    platform: 'win32',
    env: { AGY_COMMAND: explicit, PATH: 'C:\\path', PATHEXT: '.EXE' },
    fsImpl: fakeFs(new Set([explicit, pathCandidate]), calls)
  });

  assert.deepEqual(result, { path: explicit, source: 'explicit' });
  assert.equal(calls.some(([, candidate]) => candidate === pathCandidate), false);
});

test('an invalid explicit executable does not fall back to PATH or standard paths', async () => {
  const calls = [];
  const result = await resolveExecutable({
    name: 'agy',
    platform: 'linux',
    env: { AGY_COMMAND: '/missing/agy', PATH: '/available', HOME: '/home/test' },
    fsImpl: fakeFs(new Set(['/available/agy', '/home/test/.local/bin/agy']), calls)
  });

  assert.equal(result, null);
  assert.deepEqual(calls.map(([, candidate]) => candidate), ['/missing/agy']);
});

test('PATH resolution returns an absolute executable path and skips missing entries', async () => {
  const result = await resolveExecutable({
    name: 'buzz',
    platform: 'linux',
    env: { PATH: 'relative tools:/other' },
    fsImpl: fakeFs(new Set(['relative tools/buzz']))
  });

  assert.equal(result?.source, 'path');
  assert.match(result?.path ?? '', /[\\/]relative tools[\\/]buzz$/);
  assert.equal(result?.path.startsWith('/'), true);
});

test('standard user install paths are searched after PATH', async () => {
  const standard = '/home/test/.local/bin/agy';
  const result = await resolveExecutable({
    name: 'agy',
    platform: 'linux',
    env: { PATH: '/missing', HOME: '/home/test' },
    fsImpl: fakeFs(new Set([standard]))
  });

  assert.deepEqual(result, { path: standard, source: 'standard' });
});

test('standard CLI bin locations include the observed Windows agy install', async () => {
  const standard = 'C:\\Users\\tester\\AppData\\Local\\agy\\bin\\agy.exe';
  const result = await resolveExecutable({
    name: 'agy',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    fsImpl: fakeFs(new Set([standard]))
  });

  assert.deepEqual(result, { path: standard, source: 'standard' });
});

test('standard CLI bin locations include agy and cargo user bins', async () => {
  const standard = '/home/test/.cargo/bin/buzz';
  const result = await resolveExecutable({
    name: 'buzz',
    platform: 'linux',
    env: { HOME: '/home/test' },
    fsImpl: fakeFs(new Set([standard]))
  });

  assert.deepEqual(result, { path: standard, source: 'standard' });
});

test('Windows batch shims are refused even when present', async () => {
  const result = await resolveExecutable({
    name: 'buzz',
    platform: 'win32',
    env: { BUZZ_CLI_COMMAND: 'C:\\tools\\buzz.cmd' },
    fsImpl: fakeFs(new Set(['C:\\tools\\buzz.cmd']))
  });

  assert.equal(result, null);
});

test('POSIX resolution checks executable access', async () => {
  const calls = [];
  await resolveExecutable({
    name: 'agy',
    platform: 'linux',
    env: { AGY_COMMAND: '/tools/agy' },
    fsImpl: fakeFs(new Set(['/tools/agy']), calls)
  });

  assert.equal(calls.some(([, candidate, mode]) => candidate === '/tools/agy' && mode === 1), true);
});
