// Standalone fixture, deliberately plain JS with no dependency on this
// package's own build: binds the path given as argv[2] and reports
// readiness on stdout, then idles until killed. Used by
// processLock.test.ts to prove the lock is released the instant its
// holder dies, not just on a graceful close -- a real second process,
// not a simulation within the test's own process.
import { createServer } from 'node:net';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: holdSocketPath.mjs <path>\n');
  process.exit(1);
}

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
