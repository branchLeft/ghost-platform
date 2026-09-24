// A stand-in for the real, sudoers-enumerated `/usr/local/sbin/branchleft-slot`
// (LLD-2 §02) -- this repo has no root and cannot install a real sudoers
// entry, so `wrapper.test.ts` and `app.test.ts` point `wrapper.ts` at this
// script instead (via `prefix: [process.execPath]`), proving the argv
// discipline `wrapper.ts` itself is responsible for: each invocation
// argument arrives as its own `process.argv` element, never merged.
import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_WRAPPER_LOG;
const args = process.argv.slice(2);
if (logPath) {
  appendFileSync(logPath, JSON.stringify(args) + '\n');
}
if (process.env.FAKE_WRAPPER_FAIL === '1') {
  process.stderr.write('fake wrapper: forced failure\n');
  process.exit(1);
}
process.exit(0);
