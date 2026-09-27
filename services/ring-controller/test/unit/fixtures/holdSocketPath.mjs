// Standalone fixture, deliberately plain JS with no dependency on this
// package's own build: binds the name given as argv[2] and reports
// readiness on stdout, then idles until killed. Used by
// processLock.test.ts to prove the lock is released the instant its
// holder dies, not just on a graceful close -- a real second process,
// not a simulation within the test's own process.
//
// argv[2] is never the raw abstract name: `spawn()` refuses any argv
// string containing a NUL byte, on every platform, so a `\0`-prefixed
// name could never reach this file that way. When argv[3] is 'abstract',
// this process itself prepends the `\0` right before binding, the one
// place a JS string can hold a NUL freely.
import { createServer } from 'node:net';

const name = process.argv[2];
if (!name) {
  process.stderr.write('usage: holdSocketPath.mjs <name> [abstract]\n');
  process.exit(1);
}
const path = process.argv[3] === 'abstract' ? `\0${name}` : name;

const server = createServer();
server.on('error', (err) => {
  process.stderr.write(`holder bind failed: ${err.message}\n`);
  process.exit(1);
});
server.listen({ path }, () => {
  process.stdout.write('holding\n');
});

// Keeps the event loop alive until the test kills this process.
setInterval(() => {}, 1000);
