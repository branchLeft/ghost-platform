// A stand-in for a host's narrow entry point, started by the command adapter.
// argv[2] is a work directory. It reads the step from standard input, appends
// it to calls.jsonl, and then does what modes.json says for that step id
// (absent means succeed): "fail" exits 1, "permanent" exits 3, "hang" never
// exits, "noisy" prints a secret-shaped line on both streams and exits 1,
// "env" records the names of the variables it was started with.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(request)}\n`);

const modesFile = join(dir, 'modes.json');
const modes = existsSync(modesFile) ? JSON.parse(readFileSync(modesFile, 'utf8')) : {};
const mode = modes[request.id];

if (mode === 'env') writeFileSync(join(dir, 'env.json'), JSON.stringify(Object.keys(process.env)));
if (mode === 'fail') process.exit(1);
if (mode === 'permanent') process.exit(3);
if (mode === 'noisy') {
  const secret = 'SECRETVALUE0123456789abcdefghijklmnopqrstuvwxyz0123456789';
  process.stdout.write(`token=${secret}\n`);
  process.stderr.write(`password=${secret}\n`);
  process.exit(1);
}
if (mode === 'hang') setInterval(() => undefined, 1000);
