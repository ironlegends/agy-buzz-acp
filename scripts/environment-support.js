import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Tests create private state under the system temp directory. macOS exposes
// /var as a symlink; choose its canonical target without weakening runtime guards.
const canonicalTemp = realpathSync(tmpdir());
process.env.TMPDIR = canonicalTemp;
process.env.TEMP = canonicalTemp;
process.env.TMP = canonicalTemp;

const PASSTHROUGH_ENVIRONMENT = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'ProgramData', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath', 'USERNAME', 'USERDOMAIN'
];
const RUNTIME_PREFIXES = ['AGY_', 'BUZZ_'];

function isRuntimeVariable(name) {
  const normalizedName = name.toUpperCase();
  return RUNTIME_PREFIXES.some((prefix) => normalizedName.startsWith(prefix));
}

export function scrubRuntimeEnvironment(env = process.env) {
  for (const name of Object.keys(env)) {
    if (isRuntimeVariable(name)) delete env[name];
  }
  return env;
}

scrubRuntimeEnvironment();

export function isolatedChildEnvironment(overrides = {}) {
  const env = Object.fromEntries(PASSTHROUGH_ENVIRONMENT
    .filter((name) => typeof process.env[name] === 'string')
    .map((name) => [name, process.env[name]]));
  return { ...env, ...overrides };
}

export function isolatedServerOptions({ sessionFactory, publisherFactory, outboxFactory, steeringFactory, ...overrides } = {}) {
  return {
    sessionFactory: sessionFactory ?? (() => ({ prompt: async () => 'synthetic test response', cancel() {}, close() {} })),
    publisherFactory: publisherFactory ?? (() => ({
      publish: async () => ({ status: 'sent', eventId: '00'.repeat(32) })
    })),
    outboxFactory: outboxFactory ?? (() => ({ enabled: false, begin: async () => null, update: async () => null })),
    sessionStateFactory: () => null,
    steeringSupported: Boolean(steeringFactory),
    ...(steeringFactory ? { steeringFactory } : {}),
    ...overrides
  };
}
