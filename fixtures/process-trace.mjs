// Test-only tracing at the ChildProcess primitive; preserve execFile promisification.
import { ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
const original = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(options) {
  const result = original.call(this, options);
  const command = basename(String(options.file));
  const log = (phase, details = '') => process.stderr.write(`[probe-process] parent=${process.pid} phase=${phase} command=${command} pid=${this.pid ?? 'none'} ${details}\n`);
  log('start');
  this.once('error', e => log('error', e.code));
  this.once('exit', (code, signal) => log('exit', `${code}/${signal}`));
  this.once('close', (code, signal) => log('close', `${code}/${signal}`));
  return result;
};

// Test-only filesystem failures: retain the original error and never log payloads.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['rename', 'readFile']) {
  const operation = fsPromises[name];
  fsPromises[name] = (...args) => operation(...args).catch(error => {
    process.stderr.write(`[probe-fs] operation=${name} code=${error.code}\n`);
    throw error;
  });
}
syncBuiltinESMExports();
