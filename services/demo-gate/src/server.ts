import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateHandler } from './app.js';
import { hashPassphrase, parseArgon2idHash } from './argon2id.js';
import {
  createAttemptCeiling,
  createSourceResolver,
} from 'ghost-platform-request-guard/dist/index.js';
import { loadConfig } from './config.js';
import { createDerivationGate } from './derivationGate.js';
import { createMailProofReader } from './mailProof.js';
import { createLeaseReader, createSlotsSource } from './slots.js';
import { createTrafficCounterStore } from './trafficCounter.js';
import { createFileLedger } from './usedTokens.js';

const config = loadConfig(process.env);
const slots = createSlotsSource(config.slotsPath);
// Parsed once here so a malformed slots file stops the process at start
// rather than at the first visitor.
await slots();

if (config.trafficCounterDir) {
  await mkdir(config.trafficCounterDir, { recursive: true });
}

if (config.invitation) {
  // Owner-only: the ledger holds the hash of every link used, nothing else.
  await mkdir(config.invitation.ledgerDir, { recursive: true, mode: 0o700 });
}

const handler = createGateHandler({
  arrival: config.invitation
    ? {
        publicKey: config.invitation.publicKey,
        ledger: createFileLedger(config.invitation.ledgerDir),
        mailProofOf: createMailProofReader(config.invitation.mailProofDir),
        mailProofMaxAgeSeconds: config.invitation.mailProofMaxAgeSeconds,
      }
    : undefined,
  slots,
  leaseOf: createLeaseReader(config.leaseDir),
  signingKey: config.signingKey,
  trafficCounter: config.trafficCounterDir
    ? createTrafficCounterStore(config.trafficCounterDir)
    : undefined,
  ceiling: createAttemptCeiling({
    limit: config.ceilingLimit,
    windowMs: config.ceilingWindowMs,
    maxSources: config.ceilingMaxSources,
  }),
  broadCeiling: createAttemptCeiling({
    limit: config.ceilingBroadLimit,
    windowMs: config.ceilingWindowMs,
    maxSources: config.ceilingBroadMaxSources,
  }),
  malformedCeiling: createAttemptCeiling({
    limit: config.ceilingMalformedLimit,
    windowMs: config.ceilingWindowMs,
    maxSources: config.ceilingBroadMaxSources,
  }),
  derivationGate: createDerivationGate(config.argon2MaxConcurrent, config.argon2MaxQueued),
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
