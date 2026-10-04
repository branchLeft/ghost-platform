// Proof-only CLI: signs and sends one real request against the running
// broker, using the exact Ed25519 signing scheme `src/signing.ts` and
// `src/auth.ts` implement (mirrored here, not imported, since this script
// ships standalone inside the proof image rather than through the bundled
// entrypoint). Reads the 32 raw private-key bytes `make-verify-key.mjs`
// wrote at build time.
//
// Usage: node sign-request.mjs <method> <path> <body-json> <private-key-path> <base-url>
// (pass '' as <body-json> for a GET)
import { readFileSync } from 'node:fs';
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromRaw(raw) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function signingPayload(method, path, timestampSeconds, nonce, rawBody) {
  return Buffer.concat([
    Buffer.from(`${method}\n${path}\n${timestampSeconds}\n${nonce}\n`, 'utf8'),
    rawBody,
  ]);
}

const [, , method, path, bodyJson, privateKeyPath, baseUrl] = process.argv;
if (!method || !path || bodyJson === undefined || !privateKeyPath || !baseUrl) {
  console.error(
    'usage: sign-request.mjs <method> <path> <body-json> <private-key-path> <base-url>'
  );
  process.exit(2);
}

const privateKeyRaw = readFileSync(privateKeyPath);
const key = privateKeyFromRaw(privateKeyRaw);
const rawBody = Buffer.from(bodyJson, 'utf8');
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(16).toString('hex');
const signature = cryptoSign(
  null,
  signingPayload(method, path, timestamp, nonce, rawBody),
  key
).toString('base64');

const res = await fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    'X-Broker-Timestamp': timestamp,
    'X-Broker-Nonce': nonce,
    'X-Broker-Signature': signature,
  },
  // A GET carries no body at all (fetch refuses one); its signed bytes are
  // then empty, matching what the broker reads off the wire.
  body: method === 'GET' ? undefined : rawBody,
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
