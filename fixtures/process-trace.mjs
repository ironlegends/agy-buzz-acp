// Test-only tracing of child lifecycle; never inherited by a live runtime.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const log = (phase, command, pid, details = '') => process.stderr.write(`[probe-process] parent=${process.pid} phase=${phase} command=${basename(String(command))} pid=${pid ?? 'none'} ${details}\n`);
for (const method of ['spawn', 'execFile']) {
  const original = cp[method];
  cp[method] = function(command, ...args) {
    const child = original.call(this, command, ...args);
    log('start',command,child.pid);
    child.once('error',e => log('error',command,child.pid,e.code));
    child.once('exit',(code,signal) => log('exit',command,child.pid,`${code}/${signal}`));
    child.once('close',(code,signal) => log('close',command,child.pid,`${code}/${signal}`));
    return child;
  };
}
syncBuiltinESMExports();
