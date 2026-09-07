import { posix, win32 } from 'node:path';
import { resolveExecutable } from './executables.js';

const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function absolutePath(value, paths, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const trimmed = value.trim();
  if (!paths.isAbsolute(trimmed)) throw new TypeError(`${label} must be absolute`);
  return paths.resolve(trimmed);
}

function resolvedPath(result, paths) {
  if (!result || typeof result.path !== 'string' || !result.path.trim()) return null;
  return paths.resolve(result.path.trim());
}

/**
 * Build a secret-free custom harness description for a local agy/Buzz setup.
 */
export async function buildHarnessConfig({
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  adapterPath,
  resolveFn = resolveExecutable
} = {}) {
  const paths = pathApi(platform);
  const config = {
    nodePath: absolutePath(nodePath, paths, 'nodePath'),
    adapterPath: absolutePath(adapterPath, paths, 'adapterPath'),
    agyPath: null,
    buzzPath: null
  };
  const [agy, buzz] = await Promise.all([
    resolveFn({ name: 'agy', env, platform }),
    resolveFn({ name: 'buzz', env, platform })
  ]);
  const agyPath = resolvedPath(agy, paths);
  const buzzPath = resolvedPath(buzz, paths);
  if (!agyPath) throw new Error('agy executable could not be resolved; configure AGY_COMMAND or install agy on PATH');
  if (!buzzPath) throw new Error('Buzz executable could not be resolved; configure BUZZ_CLI_COMMAND or install Buzz on PATH');

  const outputEnv = {
    AGY_COMMAND: agyPath,
    BUZZ_CLI_COMMAND: buzzPath
  };
  if (env?.AGY_MODEL !== undefined) {
    if (typeof env.AGY_MODEL !== 'string' || !SAFE_MODEL_RE.test(env.AGY_MODEL)) {
      throw new Error('AGY_MODEL is invalid; use a bounded model id containing letters, numbers, ., _, :, /, or -');
    }
    outputEnv.AGY_MODEL = env.AGY_MODEL;
  }
  return {
    id: 'agy-buzz-acp',
    label: 'Antigravity (agy-buzz-acp)',
    command: config.nodePath,
    args: [config.adapterPath],
    env: outputEnv
  };
}

export function setupUsage() {
  return [
    'Usage: agy-buzz-acp setup',
    '',
    'Print a secret-free JSON harness configuration with discovered absolute executable paths.',
    'Setup does not install tools, write configuration files, or invoke agy or Buzz.'
  ].join('\n');
}
