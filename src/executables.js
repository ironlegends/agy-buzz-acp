import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

const COMMAND_VARIABLES = Object.freeze({ agy: 'AGY_COMMAND', buzz: 'BUZZ_CLI_COMMAND' });
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function valueOf(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isBatchShim(command, platform) {
  if (platform !== 'win32' || typeof command !== 'string') return false;
  const extension = win32.extname(command).toLowerCase();
  return BATCH_EXTENSIONS.has(extension);
}

function commandHasPath(command) {
  return command.includes('/') || command.includes('\\');
}

function pathEntries(env, platform) {
  const path = valueOf(env, 'PATH') ?? valueOf(env, 'Path') ?? '';
  return path.split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

function commandCandidates(command, env, platform) {
  const paths = pathApi(platform);
  if (paths.isAbsolute(command) || commandHasPath(command)) return [command];
  const entries = pathEntries(env, platform);
  if (platform !== 'win32') return entries.map((entry) => paths.join(entry, command));

  const rawExtensions = valueOf(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = rawExtensions.split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension && !BATCH_EXTENSIONS.has(extension));
  const names = command.includes('.')
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];
  return entries.flatMap((entry) => names.map((name) => paths.join(entry, name)));
}

function standardCandidates(name, env, platform) {
  const paths = pathApi(platform);
  const home = valueOf(env, 'HOME') ?? valueOf(env, 'USERPROFILE');
  // Keep this list narrow: these are user CLI bins plus the observed Windows
  // agy and Buzz installs; package managers may still be used through PATH.
  if (platform === 'win32') {
    const localAppData = valueOf(env, 'LOCALAPPDATA');
    const appData = valueOf(env, 'APPDATA');
    return [
      localAppData && name === 'buzz' && paths.join(localAppData, 'Buzz', `${name}.exe`),
      localAppData && name === 'agy' && paths.join(localAppData, 'agy', 'bin', `${name}.exe`),
      localAppData && paths.join(localAppData, 'Programs', name, `${name}.exe`),
      localAppData && paths.join(localAppData, name, `${name}.exe`),
      home && paths.join(home, '.local', 'bin', `${name}.exe`),
      home && paths.join(home, 'bin', `${name}.exe`),
      home && paths.join(home, '.agy', 'bin', `${name}.exe`),
      home && paths.join(home, '.cargo', 'bin', `${name}.exe`),
      appData && paths.join(appData, 'npm', `${name}.exe`)
    ].filter(Boolean);
  }
  return [
    home && paths.join(home, '.local', 'bin', name),
    home && paths.join(home, 'bin', name),
    home && paths.join(home, '.agy', 'bin', name),
    home && paths.join(home, '.cargo', 'bin', name),
    home && paths.join(home, '.npm-global', 'bin', name),
    '/usr/local/bin/' + name,
    '/usr/bin/' + name,
    platform === 'darwin' ? `/opt/homebrew/bin/${name}` : null
  ].filter(Boolean);
}

async function inspectCandidates(candidates, { platform, fsImpl, source, paths }) {
  const accessMode = platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK;
  for (const candidate of candidates) {
    if (isBatchShim(candidate, platform)) continue;
    try {
      const details = await fsImpl.stat(candidate);
      if (!details?.isFile?.()) continue;
      await fsImpl.access(candidate, accessMode);
      return { path: paths.resolve(candidate), source };
    } catch {
      // Missing or inaccessible candidates are equivalent during discovery.
    }
  }
  return null;
}

/**
 * Resolve an agy or Buzz executable without invoking it or using a shell.
 */
export async function resolveExecutable({
  name,
  env = process.env,
  platform = process.platform,
  fsImpl = { access, stat }
} = {}) {
  const variable = COMMAND_VARIABLES[name];
  if (!variable) throw new TypeError('name must be agy or buzz');
  const paths = pathApi(platform);
  const configured = valueOf(env, variable);
  if (configured) {
    if (isBatchShim(configured, platform)) return null;
    return inspectCandidates(commandCandidates(configured, env, platform), { platform, fsImpl, source: 'explicit', paths });
  }

  const fromPath = await inspectCandidates(commandCandidates(name, env, platform), { platform, fsImpl, source: 'path', paths });
  if (fromPath) return fromPath;
  return inspectCandidates(standardCandidates(name, env, platform), { platform, fsImpl, source: 'standard', paths });
}

export function isBatchExecutablePath(command, platform = process.platform) {
  return isBatchShim(command, platform);
}

export const executableCommandVariable = Object.freeze({ ...COMMAND_VARIABLES });
