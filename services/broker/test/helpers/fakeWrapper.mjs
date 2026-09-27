// A stand-in for the real, sudoers-enumerated `/usr/local/sbin/branchleft-slot`
// (LLD-2 §02) -- this repo has no root and cannot install a real sudoers
// entry, so `wrapper.test.ts`, `app.test.ts` and `emailBatchChecker.test.ts`
// point `wrapper.ts`/`createSudoEmailBatchChecker` at this script instead
// (via `prefix: [process.execPath]`), proving the argv discipline the
// caller itself is responsible for: each invocation argument arrives as
// its own `process.argv` element, never merged.
import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_WRAPPER_LOG;
const args = process.argv.slice(2);
if (logPath) {
  appendFileSync(logPath, JSON.stringify(args) + '\n');
}
// A controllable stand-in for a wrapper that is slow to respond -- lets
// emailBatchChecker.test.ts prove createSudoEmailBatchChecker's own
// `timeoutMs` actually bounds the call through a real subprocess, rather
// than only through a mocked `execFile`. A synchronous busy-wait, not
// `setTimeout`: this script is a one-shot CLI with no event loop work to
// yield to.
const sleepMs = process.env.FAKE_WRAPPER_SLEEP_MS;
if (sleepMs) {
  const until = Date.now() + Number(sleepMs);
  while (Date.now() < until) {
    // busy-wait
  }
}
if (process.env.FAKE_WRAPPER_FAIL === '1') {
  process.stderr.write('fake wrapper: forced failure\n');
  process.exit(1);
}
// A controllable stand-in for the real wrapper's read-only "email-batches"
// verb, which prints a bare count to stdout on success -- lets
// emailBatchChecker.test.ts drive both a real count and a malformed one
// through the exact same subprocess boundary `createSudoEmailBatchChecker`
// runs against in production, rather than mocking `execFile` away.
if (process.env.FAKE_WRAPPER_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_WRAPPER_STDOUT);
}
process.exit(0);
