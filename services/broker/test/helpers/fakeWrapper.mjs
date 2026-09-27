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
// The `load` verb is the one invocation whose stdout a caller reads
// (`wrapper.ts`'s `load()`, unlike `start`/`stop`/`reset`) -- this stands
// in for the real wrapper's own `docker load` output so
// `dockerImageLoader.test.ts` can prove its parsing without a daemon.
if (args[0] === 'load') {
  process.stdout.write(
    process.env.FAKE_WRAPPER_LOAD_OUTPUT ?? `Loaded image ID: sha256:${'0'.repeat(64)}\n`
  );
}
process.exit(0);
