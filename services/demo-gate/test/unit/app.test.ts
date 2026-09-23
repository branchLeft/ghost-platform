import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hashIdOf,
  validateLeaseId,
  validateSlotName,
  type HashId,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import { createGateHandler, VERIFY_PATH, type GateDeps } from '../../src/app.js';
import { hashPassphrase, parseArgon2idHash, type Argon2idHash } from '../../src/argon2id.js';
import { createAttemptCeiling } from '../../src/ceiling.js';
import { COOKIE_NAME, signCookie } from '../../src/cookie.js';
import { createDerivationGate, DerivationGateFullError } from '../../src/derivationGate.js';
import {
  createLeaseReader,
  createSlotsSource,
  type CurrentLease,
  type GatedHost,
} from '../../src/slots.js';
import { createSourceResolver, parseTrustedProxies } from '../../src/source.js';

const FAST = { memoryKiB: 8192, passes: 1, parallelism: 1 };
const KEY = Buffer.alloc(32, 3);
const HOST = 'a1b2.demo.example';
const OTHER_HOST = 'c3d4.demo.example';
const SLOT = validateSlotName('0');
const OTHER_SLOT = validateSlotName('1');
const LEASE_1 = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9D');
const LEASE_2 = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9E');
const PASSPHRASE = 'correct horse battery';
const NOW_MS = 1_900_000_000_000;

let slotHashPhc: string;
let slotHash: Argon2idHash;
let slotHashId: HashId;
let decoyHash: Argon2idHash;

beforeAll(async () => {
  slotHashPhc = await hashPassphrase(PASSPHRASE, FAST);
  slotHash = parseArgon2idHash(slotHashPhc);
  slotHashId = hashIdOf(slotHashPhc);
  decoyHash = parseArgon2idHash(await hashPassphrase('decoy', FAST));
});

interface Harness {
  deps: GateDeps;
  leases: Map<SlotName, CurrentLease>;
  logs: string[];
  now: { ms: number };
  base: string;
}

let server: Server;
let h: Harness;

async function start(over: Partial<GateDeps> = {}): Promise<Harness> {
  const leases = new Map<SlotName, CurrentLease>([
    [SLOT, { lease: LEASE_1, hashId: slotHashId }],
    [OTHER_SLOT, { lease: LEASE_1, hashId: slotHashId }],
  ]);
  const logs: string[] = [];
  const now = { ms: NOW_MS };
  const slots = new Map<string, GatedHost>([
    [HOST, { host: HOST, slot: SLOT, hash: slotHash, hashId: slotHashId }],
    [OTHER_HOST, { host: OTHER_HOST, slot: OTHER_SLOT, hash: slotHash, hashId: slotHashId }],
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
    derivationGate: createDerivationGate(4, 64),
    sources: createSourceResolver(parseTrustedProxies('127.0.0.1')),
    cookieTtlSeconds: 3600,
    decoyHash,
    nowMs: () => now.ms,
    log: (line) => logs.push(line),
    ...over,
  };
  const handler = createGateHandler(deps);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { deps, leases, logs, now, base: `http://127.0.0.1:${port}` };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(`${h.base}${path}`, { method, headers }, (res) => {
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
}

const verifyAs = (host: string, cookie?: string, extra: Record<string, string> = {}) =>
  send('GET', VERIFY_PATH, { host, ...(cookie ? { cookie } : {}), ...extra });

const login = (
  passphrase: string,
  opts: { host?: string; source?: string; r?: string; contentType?: string } = {}
) =>
  send(
    'POST',
    '/__gate/login',
    {
      host: opts.host ?? HOST,
      'content-type': opts.contentType ?? 'application/x-www-form-urlencoded',
      'x-forwarded-for': opts.source ?? '203.0.113.1',
    },
    new URLSearchParams({ passphrase, ...(opts.r === undefined ? {} : { r: opts.r }) }).toString()
  );

const cookieFor = (slot: SlotName, lease: LeaseId, exp = NOW_MS / 1000 + 3600) =>
  `${COOKIE_NAME}=${signCookie(KEY, { slot, lease, exp })}`;

function cookieFrom(reply: Reply): string {
  const header = reply.headers['set-cookie'];
  const value = (Array.isArray(header) ? header[0] : header) ?? '';
  return value.split(';')[0] ?? '';
}

beforeEach(async () => {
  h = await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('verify (the forward_auth target)', () => {
  it('refuses a request with no cookie, showing the passphrase form for the original path', async () => {
    const reply = await verifyAs(HOST, undefined, { 'x-forwarded-uri': '/ghost/#/dashboard' });
    expect(reply.status).toBe(401);
    expect(reply.body).toContain('name="passphrase"');
    expect(reply.body).toContain('value="/ghost/#/dashboard"');
    expect(reply.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it("admits a valid cookie for the current lease of this host's slot", async () => {
    expect((await verifyAs(HOST, cookieFor(SLOT, LEASE_1))).status).toBe(200);
  });

  it('answers HEAD the same way as GET', async () => {
    const reply = await send('HEAD', VERIFY_PATH, { host: HOST, cookie: cookieFor(SLOT, LEASE_1) });
    expect(reply.status).toBe(200);
  });

  it('refuses a cookie issued against a lease the slot no longer holds', async () => {
    const cookie = cookieFor(SLOT, LEASE_1);
    h.leases.set(SLOT, { lease: LEASE_2, hashId: slotHashId });
    expect((await verifyAs(HOST, cookie)).status).toBe(401);
  });

  it('refuses every cookie when the slot has no current lease', async () => {
    h.leases.delete(SLOT);
    expect((await verifyAs(HOST, cookieFor(SLOT, LEASE_1))).status).toBe(401);
  });

  it('refuses a valid cookie for another slot on this host', async () => {
    expect((await verifyAs(HOST, cookieFor(OTHER_SLOT, LEASE_1))).status).toBe(401);
  });

  it('refuses an expired cookie', async () => {
    expect((await verifyAs(HOST, cookieFor(SLOT, LEASE_1, NOW_MS / 1000 - 1))).status).toBe(401);
  });

  it('refuses a tampered cookie', async () => {
    const cookie = cookieFor(SLOT, LEASE_1);
    const tampered = cookie.replace(LEASE_1, LEASE_2);
    expect((await verifyAs(HOST, tampered)).status).toBe(401);
  });

  it('admits when one of several gate cookies is valid', async () => {
    const reply = await verifyAs(HOST, `${cookieFor(SLOT, LEASE_2)}; ${cookieFor(SLOT, LEASE_1)}`);
    expect(reply.status).toBe(200);
  });

  it('refuses an unknown host, and a request with no host at all', async () => {
    expect((await verifyAs('unknown.demo.example', cookieFor(SLOT, LEASE_1))).status).toBe(401);
    const noHost = await new Promise<number>((resolve, reject) => {
      const req = request(`${h.base}${VERIFY_PATH}`, { setHost: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect([400, 401]).toContain(noHost);
  });

  it('ignores the port on the host header', async () => {
    expect((await verifyAs(`${HOST}:443`, cookieFor(SLOT, LEASE_1))).status).toBe(200);
  });

  it('never reflects an off-site return path into the form', async () => {
    const reply = await verifyAs(HOST, undefined, { 'x-forwarded-uri': '//evil.example/' });
    expect(reply.body).toContain('value="/"');
  });
});

describe('login', () => {
  it('issues a lease-bound cookie and redirects to the return path on the right passphrase', async () => {
    const reply = await login(PASSPHRASE, { r: '/ghost/' });
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe('/ghost/');
    const setCookie = String(reply.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=3600/);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).toContain(`.${LEASE_1}.`);
    expect((await verifyAs(HOST, cookieFrom(reply))).status).toBe(200);
  });

  it('issues a cookie that dies when the slot is recycled', async () => {
    const cookie = cookieFrom(await login(PASSPHRASE));
    h.leases.set(SLOT, { lease: LEASE_2, hashId: slotHashId });
    expect((await verifyAs(HOST, cookie)).status).toBe(401);
  });

  it('issues a cookie that expires with its TTL', async () => {
    const cookie = cookieFrom(await login(PASSPHRASE));
    h.now.ms += 3600 * 1000;
    expect((await verifyAs(HOST, cookie)).status).toBe(401);
  });

  it('issues a cookie that does not open another slot', async () => {
    const cookie = cookieFrom(await login(PASSPHRASE));
    expect((await verifyAs(OTHER_HOST, cookie)).status).toBe(401);
  });

  it('refuses a wrong passphrase with the form and no cookie', async () => {
    const reply = await login('wrong');
    expect(reply.status).toBe(401);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.body).toContain('DEMO_GATE_WRONG_PASSPHRASE');
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('refuses the right passphrase on a slot with no current lease', async () => {
    h.leases.delete(SLOT);
    const reply = await login(PASSPHRASE);
    expect(reply.status).toBe(401);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('refuses the right passphrase on an unknown host', async () => {
    const reply = await login(PASSPHRASE, { host: 'unknown.demo.example' });
    expect(reply.status).toBe(401);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('refuses with 503 and no cookie when the derivation gate is full, without denying the passphrase', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({
      derivationGate: {
        run: () => {
          throw new DerivationGateFullError();
        },
      },
    });
    const reply = await login(PASSPHRASE);
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('1');
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.body).not.toContain('DEMO_GATE_WRONG_PASSPHRASE');
  });

  it('propagates an unexpected derivation-gate error as a 500, not a 503', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({
      derivationGate: {
        run: () => {
          throw new Error('gate wiring broke');
        },
      },
    });
    const reply = await login(PASSPHRASE);
    expect(reply.status).toBe(500);
    expect(h.logs.join()).toContain('gate wiring broke');
  });

  it('refunds the ceiling attempt on a 503, so it never counts against the visitor', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let calls = 0;
    h = await start({
      derivationGate: {
        run: () => {
          calls += 1;
          throw new DerivationGateFullError();
        },
      },
      ceiling: createAttemptCeiling({ limit: 1, windowMs: 60_000, maxSources: 100 }),
    });
    expect((await login(PASSPHRASE)).status).toBe(503);
    // Had the first attempt not been refunded, a ceiling of 1 would refuse
    // this second one with 429 before the derivation gate is ever asked --
    // `calls` would stay at 1.
    expect((await login(PASSPHRASE)).status).toBe(503);
    expect(calls).toBe(2);
  });

  it('refuses past the ceiling from one source while another source still gets through', async () => {
    for (let i = 0; i < 3; i++) expect((await login('wrong')).status).toBe(401);
    const refused = await login(PASSPHRASE);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect((await login(PASSPHRASE, { source: '203.0.113.2' })).status).toBe(303);
  });

  it('cannot be reset by a client adding its own X-Forwarded-For entries to the left', async () => {
    for (let i = 0; i < 3; i++) await login('wrong');
    const reply = await login(PASSPHRASE, { source: '198.51.100.7, 203.0.113.1' });
    expect(reply.status).toBe(429);
  });

  it('keys on the socket peer when the peer is not a trusted proxy', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({ sources: createSourceResolver(parseTrustedProxies('')) });
    for (let i = 0; i < 3; i++) await login('wrong', { source: `198.51.100.${i}` });
    expect((await login(PASSPHRASE, { source: '198.51.100.99' })).status).toBe(429);
  });

  it('refuses once the broad ceiling trips, even though each /64 is still under its own narrow limit', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({
      broadCeiling: createAttemptCeiling({ limit: 2, windowMs: 60_000, maxSources: 100 }),
    });
    // Three distinct /64s inside one /48: none trips its own narrow limit
    // of 3, but all three share one broad bucket capped at 2.
    const addr = (suffix: string) => `2001:db8:aaaa:${suffix}::1`;
    expect((await login('wrong', { source: addr('0') })).status).toBe(401);
    expect((await login('wrong', { source: addr('1') })).status).toBe(401);
    const third = await login(PASSPHRASE, { source: addr('2') });
    expect(third.status).toBe(429);
  });

  it('refuses a trusted peer that did not say who the client is', async () => {
    const reply = await send(
      'POST',
      '/__gate/login',
      { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      `passphrase=${encodeURIComponent(PASSPHRASE)}`
    );
    expect(reply.status).toBe(403);
    expect(h.logs.join()).toContain('source could not be established');
  });

  it.each([
    ['a JSON body', { contentType: 'application/json' }],
    ['an empty passphrase', {}],
  ])('rejects %s', async (_label, opts) => {
    const passphrase = _label === 'an empty passphrase' ? '' : PASSPHRASE;
    expect((await login(passphrase, opts)).status).toBe(400);
  });

  it('rejects an over-long passphrase without deriving it', async () => {
    expect((await login('x'.repeat(257))).status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const reply = await send(
      'POST',
      '/__gate/login',
      {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.1',
      },
      `passphrase=${'x'.repeat(4096)}`
    );
    expect(reply.status).toBe(400);
  });

  it('falls back to the root for an off-site return path', async () => {
    expect((await login(PASSPHRASE, { r: 'https://evil.example/' })).headers.location).toBe('/');
    expect(
      (await login(PASSPHRASE, { r: '/\\evil.example', source: '203.0.113.5' })).headers.location
    ).toBe('/');
  });
});

/**
 * The recycle race: `login()` reads the slot's hash from the slots file
 * and the current lease from a separate lease record, then binds the
 * cookie to whatever lease it read. The two files are written by the
 * broker independently, at different moments, with no shared transaction,
 * so a hash and a lease read a moment apart can belong to two different
 * tenancies unless something checks that they agree -- without that
 * check, a previous visitor's old passphrase could mint a cookie bound to
 * the *new* lease during a recycle. `hashId` is that check (see
 * render-core/src/lease.ts).
 *
 * This suite goes straight at `createSlotsSource`/`createLeaseReader` --
 * the real file-backed readers, not the in-memory `Map`s the rest of this
 * file uses -- because the race lives entirely in how two independently
 * written files interact, which an in-memory double cannot reproduce.
 */
describe('the recycle race, against the real file-backed slots and lease readers', () => {
  const RACE_HOST = 'race.demo.example';
  const RACE_SLOT = validateSlotName('race');
  const OLD_PASSPHRASE = 'the-previous-visitors-passphrase';
  const NEW_PASSPHRASE = 'the-next-visitors-passphrase';
  const OLD_LEASE = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9F');
  const NEW_LEASE = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1BA0');

  let dir: string;
  let oldHashPhc: string;
  let newHashPhc: string;

  beforeAll(async () => {
    oldHashPhc = await hashPassphrase(OLD_PASSPHRASE, FAST);
    newHashPhc = await hashPassphrase(NEW_PASSPHRASE, FAST);
  });

  function writeSlots(hashPhc: string): void {
    writeFileSync(
      join(dir, 'slots.json'),
      JSON.stringify({
        slots: [
          { host: RACE_HOST, slot: RACE_SLOT, gate: { kind: 'passphrase', argon2idHash: hashPhc } },
        ],
      })
    );
  }

  // Beside its final name and renamed into place, as the broker's own
  // contract requires (render-core/src/lease.ts): a reader must never see
  // a half-written record.
  function writeLease(lease: string, hashPhc: string): void {
    const tmpPath = join(dir, `.${RACE_SLOT}.tmp`);
    writeFileSync(tmpPath, JSON.stringify({ slot: RACE_SLOT, lease, hashId: hashIdOf(hashPhc) }));
    renameSync(tmpPath, join(dir, `${RACE_SLOT}.json`));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'demo-gate-race-'));
    writeSlots(oldHashPhc);
    writeLease(OLD_LEASE, oldHashPhc);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({
      slots: createSlotsSource(join(dir, 'slots.json')),
      leaseOf: createLeaseReader(dir),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a tied pair (both files agree) admits the passphrase that matches them, ordinary operation', async () => {
    const reply = await login(OLD_PASSPHRASE, { host: RACE_HOST });
    expect(reply.status).toBe(303);
  });

  it('Race A: the new lease record lands before the new hash -- the old passphrase must not mint a cookie on the new lease', async () => {
    // Mid-recycle: the lease record already names the new tenancy (a fresh
    // lease id, hashId tied to the hash the broker is about to write), but
    // slots.json still serves the old hash -- exactly the window the
    // vulnerable code trusted.
    writeLease(NEW_LEASE, newHashPhc);
    const reply = await login(OLD_PASSPHRASE, { host: RACE_HOST });
    expect(reply.status).toBe(401);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('once both files catch up to the new tenancy, the new passphrase is admitted and bound to the new lease', async () => {
    writeSlots(newHashPhc);
    writeLease(NEW_LEASE, newHashPhc);
    const reply = await login(NEW_PASSPHRASE, { host: RACE_HOST });
    expect(reply.status).toBe(303);
    expect(String(reply.headers['set-cookie'])).toContain(`.${NEW_LEASE}.`);
  });

  it('a lease record whose hashId names neither the old nor the new hash refuses everyone', async () => {
    writeLease(NEW_LEASE, 'a-hash-string-belonging-to-no-write-that-happened');
    expect((await login(OLD_PASSPHRASE, { host: RACE_HOST })).status).toBe(401);
    expect((await login(NEW_PASSPHRASE, { host: RACE_HOST })).status).toBe(401);
  });
});

describe('everything else', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/__gate/login'],
    ['POST', VERIFY_PATH],
    ['GET', '/__gate/verifyx'],
  ])('answers %s %s with 404', async (method, path) => {
    expect((await send(method, path, { host: HOST })).status).toBe(404);
  });

  it('fails closed with a 500 when the slots source throws', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h = await start({
      slots: async () => {
        throw new Error('slots file unreadable');
      },
    });
    const reply = await verifyAs(HOST, cookieFor(SLOT, LEASE_1));
    expect(reply.status).toBe(500);
    expect(h.logs.join()).toContain('slots file unreadable');
  });
});
