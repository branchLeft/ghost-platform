// The stand-in's `register DOMAIN --sender-domain DOMAIN`: mints the domain's
// API key, records it where server.js reads it, and prints the key last, as
// the real mailgun-shim CLI does. Node built-ins only.
const fs = require('node:fs');
const crypto = require('node:crypto');

const KEYS = process.env.SHIM_KEYS_PATH || '/data/keys.json';
const [command, domain] = process.argv.slice(2);
if (command !== 'register' || !domain) {
  console.error('usage: cli.js register DOMAIN --sender-domain DOMAIN');
  process.exit(2);
}
let keys = {};
try {
  keys = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
} catch {
  keys = {};
}
const key = crypto.randomBytes(24).toString('hex');
keys[domain] = key;
fs.mkdirSync(require('node:path').dirname(KEYS), { recursive: true });
fs.writeFileSync(KEYS, JSON.stringify(keys));
console.log(`registered ${domain}`);
console.log(key);
