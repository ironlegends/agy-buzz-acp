import { appendFile, writeFile } from 'node:fs/promises';

if (process.env.BUZZ_ARGS_FILE) {
  await writeFile(process.env.BUZZ_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.argv.includes('users') && process.argv.includes('get')) {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--format', 'json', 'users', 'get'])) process.exit(1);
  process.stdout.write(JSON.stringify({ pubkey: process.env.BUZZ_SELF_PUBKEY || '1'.repeat(64) }) + '\n');
  process.exit(0);
}
if (process.env.BUZZ_CALLS_FILE) {
  await appendFile(process.env.BUZZ_CALLS_FILE, '1\n');
}
let content = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { content += chunk; });
process.stdin.on('end', async () => {
  if (process.env.BUZZ_CONTENT_FILE) await writeFile(process.env.BUZZ_CONTENT_FILE, content);
  if (process.env.BUZZ_FAKE_FAIL === '1') {
    process.exitCode = 1;
    return;
  }
  const eventId = process.env.BUZZ_EVENT_ID || 'c'.repeat(64);
  process.stdout.write(JSON.stringify({ accepted: true, event_id: eventId }) + '\n');
});
