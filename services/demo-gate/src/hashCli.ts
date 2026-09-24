import { hashPassphrase } from './argon2id.js';

// Reads the passphrase from stdin, never argv, so it does not land in a
// process listing or a shell history.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const passphrase = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '');
if (passphrase.length === 0) {
  console.error('usage: printf %s "$PASSPHRASE" | node dist/hashCli.js');
  process.exit(2);
}
console.log(await hashPassphrase(passphrase));
