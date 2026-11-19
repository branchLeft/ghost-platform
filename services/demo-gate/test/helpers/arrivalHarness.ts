import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashIdOf,
  validateLeaseId,
  validateSlotName,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import type { GateDeps } from '../../src/app.js';
import { createGateHandler as realCreateGateHandler } from '../../src/app.js';
import { hashPassphrase, parseArgon2idHash } from '../../src/argon2id.js';
import { createDerivationGate } from '../../src/derivationGate.js';
import { parseInvitationPublicKey } from '../../src/invitation.js';
import { createMailProofReader, mailProofFileName } from '../../src/mailProof.js';
import type { CurrentLease, GatedHost } from '../../src/slots.js';
import { createFileLedger as realCreateFileLedger } from '../../src/usedTokens.js';
import {
  createAttemptCeiling,
  createSourceResolver,
  parseTrustedProxies,
} from 'ghost-platform-request-guard/dist/index.js';
import { generateKeyPair, mintInvitation } from './invitations.js';

const FAST = { memoryKiB: 8192, passes: 1, parallelism: 1 };

export const KEY = Buffer.alloc(32, 3);
export const HOST = 'a1b2.demo.example';
export const OTHER_HOST = 'c3d4.demo.example';
export const SLOT = validateSlotName('0');
export const OTHER_SLOT = validateSlotName('1');
export const LEASE_1 = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9D');
export const LEASE_2 = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9E');
export const NOW_MS = 1_900_000_000_000;
export const NOW_S = NOW_MS / 1000;
export const MAX_INVALID_ATTEMPTS = 4;
export const PASSPHRASE = 'correct horse battery';
export const keys = generateKeyPair();

const FORM = 'application/x-www-form-urlencoded';
const SOURCE = { 'x-forwarded-for': '203.0.113.7' };

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** The pieces a sabotage test may swap for a mutated copy of the real module. */
export interface Modules {
  readonly createGateHandler?: typeof realCreateGateHandler;
  readonly createFileLedger?: typeof realCreateFileLedger;
}

export interface ArrivalHarness {
  readonly port: number;
  readonly deps: GateDeps;
  readonly leases: Map<SlotName, CurrentLease>;
  readonly logs: string[];
  readonly now: { ms: number };
  readonly proofDir: string;
  readonly ledgerDir: string;
  send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<Reply>;
  follow(token: string, host?: string, method?: string): Promise<Reply>;
  exchange(token: string, host?: string, source?: Record<string, string>): Promise<Reply>;
  proveMail(slot?: SlotName, lease?: LeaseId, provedAt?: number): void;
  mint(over?: Parameters<typeof mintInvitation>[1]): string;
  stop(): Promise<void>;
}

let decoy: ReturnType<typeof parseArgon2idHash> | undefined;
let slotHash: ReturnType<typeof parseArgon2idHash> | undefined;
let slotHashId: ReturnType<typeof hashIdOf> | undefined;

async function fixtures(): Promise<void> {
  if (decoy !== undefined) return;
  const phc = await hashPassphrase(PASSPHRASE, FAST);
  slotHash = parseArgon2idHash(phc);
  slotHashId = hashIdOf(phc);
  decoy = parseArgon2idHash(await hashPassphrase('decoy', FAST));
}

/** A real gate handler over a real http server, real ledger and proof files, a controllable clock. */
export async function startArrivalHarness(
  mods: Modules = {},
  withArrival = true,
  startMs = NOW_MS
): Promise<ArrivalHarness> {
  await fixtures();
  const createGateHandler = mods.createGateHandler ?? realCreateGateHandler;
  const createFileLedger = mods.createFileLedger ?? realCreateFileLedger;
  const proofDir = mkdtempSync(join(tmpdir(), 'arrival-proof-'));
  const ledgerDir = mkdtempSync(join(tmpdir(), 'arrival-ledger-'));
  const hashId = slotHashId as ReturnType<typeof hashIdOf>;
  const hash = slotHash as ReturnType<typeof parseArgon2idHash>;
  const leases = new Map<SlotName, CurrentLease>([
    [SLOT, { lease: LEASE_1, hashId }],
    [OTHER_SLOT, { lease: LEASE_1, hashId }],
  ]);
  const logs: string[] = [];
  const now = { ms: startMs };
  const startS = Math.floor(startMs / 1000);
  const slots = new Map<string, GatedHost>([
    [HOST, { host: HOST, slot: SLOT, hash, hashId }],
    [OTHER_HOST, { host: OTHER_HOST, slot: OTHER_SLOT, hash, hashId }],
  ]);
  const deps: GateDeps = {
    slots: async () => slots,
    leaseOf: async (slot) => {
      const current = leases.get(slot);
      if (!current) throw new Error('no lease');
      return current;
    },
    signingKey: KEY,
    ceiling: createAttemptCeiling({ limit: 3, windowMs: 60_000, maxSources: 100 }),
    broadCeiling: createAttemptCeiling({ limit: 100, windowMs: 60_000, maxSources: 100 }),
    malformedCeiling: createAttemptCeiling({
      limit: MAX_INVALID_ATTEMPTS,
      windowMs: 60_000,
      maxSources: 100,
    }),
    derivationGate: createDerivationGate(4, 64),
    sources: createSourceResolver(parseTrustedProxies('127.0.0.1')),
    cookieTtlSeconds: 3600,
    decoyHash: decoy as ReturnType<typeof parseArgon2idHash>,
    nowMs: () => now.ms,
    log: (line) => logs.push(line),
    ...(withArrival
      ? {
          arrival: {
            publicKey: parseInvitationPublicKey(keys.publicKeyBase64),
            ledger: createFileLedger(ledgerDir),
            mailProofOf: createMailProofReader(proofDir),
            mailProofMaxAgeSeconds: 600,
          },
        }
      : {}),
  };
  const handler = createGateHandler(deps);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const send: ArrivalHarness['send'] = (method, path, headers, body) =>
    new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
        );
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  return {
    port,
    deps,
    leases,
    logs,
    now,
    proofDir,
    ledgerDir,
    send,
    follow: (token, host = HOST, method = 'GET') =>
      send(method, `/__gate/enter?t=${encodeURIComponent(token)}`, { host, ...SOURCE }),
    exchange: (token, host = HOST, source = SOURCE) =>
      send(
        'POST',
        '/__gate/enter',
        { host, 'content-type': FORM, ...source },
        new URLSearchParams({ t: token }).toString()
      ),
    proveMail: (slot = SLOT, lease = LEASE_1, provedAt = startS) =>
      writeFileSync(
        join(proofDir, mailProofFileName(slot)),
        JSON.stringify({ slot, lease, provedAt })
      ),
    mint: (over = { host: HOST }) => mintInvitation(keys.privateKey, over, startS),
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(proofDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    },
  };
}

export const jtiOf = (token: string): string =>
  (
    JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
      jti: string;
    }
  ).jti;

export const cookieOf = (reply: Reply): string => {
  const header = reply.headers['set-cookie'];
  return ((Array.isArray(header) ? header[0] : header) ?? '').split(';')[0] ?? '';
};
