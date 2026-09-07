import { writeFile } from 'node:fs/promises';

if (process.env.AGY_ARGS_FILE) {
  await writeFile(process.env.AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.AGY_CWD_FILE) {
  await writeFile(process.env.AGY_CWD_FILE, process.cwd());
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const text = event.message?.content;
    const emit = () => {
      if (text !== 'result-only') {
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: `${text}\n` } }) + '\n');
      }
      process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `${text}\n` } }) + '\n');
    };
    if (text.endsWith('slow')) setTimeout(emit, 5000);
    else emit();
  }
});
