// Standalone fixture: binds argv[2] (optionally NUL-prefixed abstract)
// and reports readiness on stdout. See README.md in this directory for
// why this needs a real second process.
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
