import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('users') && process.argv.includes('get')) {
  console.log(JSON.stringify({ pubkey: 'ab'.repeat(32) }));
} else {
  let content = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { content += chunk; });
  process.stdin.on('end', () => {
    appendFileSync(join(process.env.PROBE_DIR, 'publications.jsonl'), JSON.stringify({ at: Date.now(), content, argv: process.argv.slice(2) }) + '\n');
    if (process.env.PROBE_PUBLICATION_UNCERTAIN === '1') { process.exitCode = 1; return; }
    console.log(JSON.stringify({ accepted: true, event_id: 'cd'.repeat(32) }));
  });
}
