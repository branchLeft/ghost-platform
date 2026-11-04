// The stand-in's `register DOMAIN --sender-domain DOMAIN`: mints the domain's
// API key, records it with its sender domain where server.js reads them, and
// prints the key last, as the real mailgun-shim CLI does. Like the real CLI it
// refuses a register with no --sender-domain. Node built-ins only.
const fs = require('node:fs');
const crypto = require('node:crypto');

const KEYS = process.env.SHIM_KEYS_PATH || '/data/keys.json';
const [command, domain, ...rest] = process.argv.slice(2);
const flag = rest.indexOf('--sender-domain');
const senderDomain = flag >= 0 ? rest[flag + 1] : undefined;
if (command !== 'register' || !domain || !senderDomain) {
  console.error('usage: cli.js register DOMAIN --sender-domain DOMAIN');
  process.exit(2);
}
let registry = {};
try {
  registry = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
} catch {
  registry = {};
}
const key = crypto.randomBytes(24).toString('hex');
registry[domain] = { key, senderDomain };
fs.mkdirSync(require('node:path').dirname(KEYS), { recursive: true });
fs.writeFileSync(KEYS, JSON.stringify(registry));
console.log(`registered ${domain}`);
console.log(key);
