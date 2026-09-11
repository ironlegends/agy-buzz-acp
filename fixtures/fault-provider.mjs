// Synthetic provider: no network, tools, or real credentials. Drives the installed adapter over stdio.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.PROBE_DIR;
const convArg = process.argv.indexOf('--conversation');
const conversationId = convArg >= 0 ? process.argv[convArg + 1] : 'fault-probe-conversation';
let initialized = false, corrected = false, sequence = 1, busy = false;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const note = (kind, extra = {}) => appendFileSync(join(dir, 'trace.jsonl'), JSON.stringify({ kind, pid: process.pid, at: Date.now(), ...extra }) + '\n');
const init = () => { if (!initialized) { initialized = true; emit({ event: 'init', conversation_id: conversationId }); } };
const step = (step_type, step_index, extra = {}) => emit({ event: 'step_update', step_update: { step_type, step_index, conversation_id: conversationId, ...extra } });
note('providerStarted', { conversationId, resumed: convArg >= 0, cwd: process.cwd(), model: process.argv[process.argv.indexOf('--model') + 1] });
if (convArg >= 0) init();
createInterface({ input: process.stdin }).on('line', (line) => {
  const event = JSON.parse(line);
  if (event.event !== 'user') return;
  init(); step('user_input', 0); step('agent_response', 1, { text_delta: 'BASE' });
  note('promptReceived', { message: event.message.content });
});
process.stdin.on('end', () => process.exit(0));
process.on('exit', () => note('providerExit'));
setInterval(() => {
  const path = join(dir, `command.${process.pid}.${sequence}.json`);
  if (busy || !existsSync(path)) return;
  let message; try { message = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  sequence += 1;
  if (message.kind === 'finish') {
    emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: conversationId, response: corrected ? 'BASECORRECTED' : 'BASE' } });
    return;
  }
  if (message.kind !== 'claim') return;
  busy = true;
  const child = spawn(process.execPath, [join(process.env.PROBE_RUNTIME, 'bin', 'agy-buzz-steer-hook.js')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let output = '', error = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { error += data; });
  child.on('error', () => note('hookError', { reason: 'spawn failed' }));
  child.on('close', (code) => {
    busy = false;
    let result; try { result = JSON.parse(output); } catch { note('hookError', { reason: 'invalid output', code }); return; }
    note('claimReturned', { code, injections: result.injectSteps?.length ?? 0, stderrLength: error.length, hookDiagnostic: result.injectSteps?.length === 1 ? undefined : error });
    if (result.injectSteps?.length === 1 && message.confirmAfterMs >= 0) {
      setTimeout(() => { corrected = true; step('user_input', 2); step('agent_response', 3, { text_delta: 'CORRECTED' }); note('confirmationEmitted'); }, message.confirmAfterMs);
    }
  });
  child.stdin.end(JSON.stringify({ conversationId, invocationNum: 1, workspacePaths: [] }));
}, 30);
