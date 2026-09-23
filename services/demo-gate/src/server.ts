import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateHandler } from './app.js';
import { hashPassphrase, parseArgon2idHash } from './argon2id.js';
import { createAttemptCeiling } from './ceiling.js';
import { loadConfig } from './config.js';
import { createLeaseReader, createSlotsSource } from './slots.js';
import { createSourceResolver } from './source.js';

const config = loadConfig(process.env);
const slots = createSlotsSource(config.slotsPath);
// Parsed once here so a malformed slots file stops the process at start
// rather than at the first visitor.
await slots();

const handler = createGateHandler({
  slots,
  leaseOf: createLeaseReader(config.leaseDir),
  signingKey: config.signingKey,
  ceiling: createAttemptCeiling({
    limit: config.ceilingLimit,
    windowMs: config.ceilingWindowMs,
    maxSources: config.ceilingMaxSources,
  }),
  sources: createSourceResolver(config.trustedProxies),
  cookieTtlSeconds: config.cookieTtlSeconds,
  decoyHash: parseArgon2idHash(await hashPassphrase(randomBytes(32).toString('hex'))),
  nowMs: () => Date.now(),
  log: (line) => console.error(line),
});

const server = createServer((req, res) => void handler(req, res));
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(config.port, config.host, () => {
  console.log(`demo-gate listening on ${config.host}:${config.port}`);
});

function shutdown(): void {
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
