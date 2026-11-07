import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerDb } from 'ghost-platform-portal-data/owner';
import type { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createOwnerConsole } from '../src/console/app.js';
import { createShell } from '../src/shell/app.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { serve } from './browser.js';
import { CLIENT_PORTAL, ISSUER, PROJECT_ID } from './idp.js';
import { CLIENT_LIMIT, CLIENT_TABLE_SIZE, createClientLimit } from '../src/shell/clientLimit.js';
import { parseTrustedProxies } from 'ghost-platform-request-guard/dist/index.js';
import {
  ask,
  begin,
  callbackWith,
  CLIENT_A,
  CLIENT_B,
  CLIENT_STARTER,
  concurrentCallbacks,
  EDGE,
  floodOutcome,
  forwardedFor,
  LIMIT,
  repeat,
  startRig,
  type Rig,
  type RigOptions,
} from './clientLimitRig.js';

type Handler = ReturnType<typeof createShell>;

let rig: Rig | undefined;

async function start(options: RigOptions): Promise<Rig> {
  rig = await startRig(createShell, options);
  return rig;
}

beforeEach(() => {
  rig = undefined;
});

afterEach(async () => {
  await rig?.close();
});

describe('the per-client limit on starting a sign-in', () => {
  it('lets a client start thirty, refuses the thirty-first with a retry time, and leaves another client alone', async () => {
    const running = await start({ trusted: EDGE });
    const statuses = await repeat(running, '/login', LIMIT, () => forwardedFor(CLIENT_A));
    expect(statuses).toEqual(Array.from({ length: LIMIT }, () => 302));

    const refused = await ask(running, '/login', forwardedFor(CLIENT_A));
    expect(refused.status).toBe(429);
    expect(refused.body).toBe('RATE_LIMITED');
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfter).toBeLessThanOrEqual(60);
    // A refused start is not given a pending sign-in to carry away.
    expect(refused.setCookie).toEqual([]);
    expect(refused.location).toBeNull();

    expect((await ask(running, '/login', forwardedFor(CLIENT_B))).status).toBe(302);
  });

  it('admits the client again once its minute is up', async () => {
    const running = await start({ trusted: EDGE });
    await repeat(running, '/login', LIMIT, () => forwardedFor(CLIENT_A));
    expect((await ask(running, '/login', forwardedFor(CLIENT_A))).status).toBe(429);
    running.advanceTo(59);
    expect((await ask(running, '/login', forwardedFor(CLIENT_A))).status).toBe(429);
    running.advanceTo(60);
    expect((await ask(running, '/login', forwardedFor(CLIENT_A))).status).toBe(302);
  });

  it('limits nothing when no trusted proxies are configured', async () => {
    const running = await start({});
    const statuses = await repeat(running, '/login', 100, () => forwardedFor(CLIENT_A));
    expect(statuses.every((status) => status === 302)).toBe(true);
  });

  it('keys on the socket peer when that peer is not trusted, whatever X-Forwarded-For says', async () => {
    // The peer is loopback, which this list does not trust, so a forged header
    // is ignored and every request below is one client.
    const running = await start({ trusted: '192.0.2.1' });
    const statuses = await repeat(running, '/login', LIMIT, (index) =>
      forwardedFor(`198.51.100.${index + 1}`)
    );
    expect(statuses.every((status) => status === 302)).toBe(true);
    const forged = await ask(running, '/login', forwardedFor('198.51.100.200'));
    expect(forged.status).toBe(429);
  });

  it('believes only the rightmost X-Forwarded-For entry from a trusted peer', async () => {
    const running = await start({ trusted: EDGE });
    // Everything to the left of the last entry is the client's own claim.
    const statuses = await repeat(running, '/login', LIMIT, (index) =>
      forwardedFor(`198.51.100.${index + 1}, ${CLIENT_A}`)
    );
    expect(statuses.every((status) => status === 302)).toBe(true);
    expect((await ask(running, '/login', forwardedFor(`198.51.100.250, ${CLIENT_A}`))).status).toBe(
      429
    );
    expect((await ask(running, '/login', forwardedFor(CLIENT_B))).status).toBe(302);
  });

  it('meters a trusted peer that names no client under one pooled key, and leaves named clients alone', async () => {
    const running = await start({ trusted: EDGE });
    const statuses = await repeat(running, '/login', LIMIT, () => ({}));
    expect(statuses.every((status) => status === 302)).toBe(true);
    expect((await ask(running, '/login')).status).toBe(429);
    expect((await ask(running, '/login', forwardedFor(CLIENT_A))).status).toBe(302);
  });

  it('puts every address of one IPv6 /64 in one bucket', async () => {
    const running = await start({ trusted: EDGE });
    const statuses = await repeat(running, '/login', LIMIT, (index) =>
      forwardedFor(`2001:db8:0:1::${index + 1}`)
    );
    expect(statuses.every((status) => status === 302)).toBe(true);
    expect((await ask(running, '/login', forwardedFor('2001:db8:0:1::ffff'))).status).toBe(429);
    expect((await ask(running, '/login', forwardedFor('2001:db8:0:2::1'))).status).toBe(302);
  });

  it('leaves every other route alone', async () => {
    const running = await start({ trusted: EDGE });
    for (const [path, expected] of [
      ['/healthz', 200],
      ['/shell.css', 200],
      ['/', 302],
      ['/nowhere', 404],
    ] as const) {
      const statuses = await repeat(running, path, LIMIT + 10, () => forwardedFor(CLIENT_A));
      expect(statuses.every((status) => status === expected)).toBe(true);
    }
  });
});

describe('the per-client limit on the callback', () => {
  it('refuses the thirty-first before the token endpoint is called, and keeps the two routes apart', async () => {
    const outcome = await floodOutcome(createShell);
    expect(outcome.firstThirtyLoginsAllStarted).toBe(true);
    expect(outcome.thirtyFirstLogin.status).toBe(429);
    expect(outcome.thirtyFirstLogin.retryAfter).toBeGreaterThanOrEqual(1);
    expect(outcome.thirtyFirstLogin.retryAfter).toBeLessThanOrEqual(60);
    expect(outcome.otherClientLogin.status).toBe(302);

    expect(outcome.firstThirtyCallbacksAllReachedTheIssuer).toBe(true);
    expect(outcome.thirtyFirstCallback.status).toBe(429);
    expect(outcome.thirtyFirstCallback.body).toBe('RATE_LIMITED');
    expect(outcome.thirtyFirstCallback.retryAfter).toBeGreaterThanOrEqual(1);
    expect(outcome.thirtyFirstCallback.setCookie).toEqual([]);
    expect(outcome.tokenCallsByThirtyFirstCallback).toBe(0);
  });

  it('does not let a flood of callbacks use up the same client’s sign-in starts, nor the reverse', async () => {
    const running = await start({ trusted: EDGE });
    const pending = await begin(running, forwardedFor(CLIENT_STARTER));
    for (let sent = 0; sent < LIMIT; sent += 1) {
      await callbackWith(running, pending, 'NEVER-ISSUED', forwardedFor(CLIENT_A));
    }
    expect((await callbackWith(running, pending, 'X', forwardedFor(CLIENT_A))).status).toBe(429);
    expect((await ask(running, '/login', forwardedFor(CLIENT_A))).status).toBe(302);

    await repeat(running, '/login', LIMIT, () => forwardedFor(CLIENT_B));
    expect((await ask(running, '/login', forwardedFor(CLIENT_B))).status).toBe(429);
    const answer = await callbackWith(running, pending, 'NEVER-ISSUED', forwardedFor(CLIENT_B));
    expect(answer.status).toBe(403);
  });

  it('limits nothing when no trusted proxies are configured', async () => {
    const running = await start({});
    const pending = await begin(running);
    for (let sent = 0; sent < 100; sent += 1) {
      const answer = await callbackWith(running, pending, 'NEVER-ISSUED');
      expect(answer.status).toBe(403);
    }
    expect(running.tokenCalls()).toBe(100);
  });
});

describe('a table of clients that is full', () => {
  const requestFrom = (address: string): IncomingMessage =>
    ({
      socket: { remoteAddress: EDGE },
      headers: { 'x-forwarded-for': address },
    }) as unknown as IncomingMessage;
  const address = (index: number): string =>
    `10.${Math.floor(index / 65_536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`;
  const build = () => createClientLimit({ trustedProxies: parseTrustedProxies(EDGE) });

  it('admits every new client and forgets the oldest, never refusing a visitor for lack of room', () => {
    const limit = build();
    expect(CLIENT_LIMIT).toBe(LIMIT);
    const now = 0;
    for (let sent = 0; sent < CLIENT_LIMIT; sent += 1) limit.login(requestFrom('192.0.2.1'), now);
    expect(limit.login(requestFrom('192.0.2.1'), now).allowed).toBe(false);

    for (let index = 0; index < CLIENT_TABLE_SIZE; index += 1) {
      expect(limit.login(requestFrom(address(index)), now + 1).allowed).toBe(true);
    }
    // One more client than the table holds: the oldest, 192.0.2.1, has gone.
    expect(limit.login(requestFrom('192.0.2.1'), now + 2).allowed).toBe(true);
  });

  it('keeps the oldest client while there is still room', () => {
    const limit = build();
    for (let sent = 0; sent < CLIENT_LIMIT; sent += 1) limit.login(requestFrom('192.0.2.1'), 0);
    for (let index = 0; index < CLIENT_TABLE_SIZE - 2; index += 1) {
      limit.login(requestFrom(address(index)), 1);
    }
    expect(limit.login(requestFrom('192.0.2.1'), 2).allowed).toBe(false);
  });
});

describe('a sign-in finished twice at once', () => {
  it('opens one session and refuses the other with the same answer as a replay', async () => {
    const answers = await concurrentCallbacks(createShell);
    expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400]);
    const refused = answers.find((answer) => answer.status === 400);
    expect(refused?.body).toBe('SIGN_IN_REFUSED');
    expect(refused?.setCookie.join('\n')).not.toContain('portal_session');
    const opened = answers.find((answer) => answer.status === 302);
    expect(opened?.setCookie.join('\n')).toMatch(/portal_session=/);
  });
});

describe('the two applications built on the shell', () => {
  // Neither handler touches its database for the routes below, so a stand-in
  // that would throw on use is enough to prove the wiring and nothing more.
  const common = {
    issuer: ISSUER,
    clientId: CLIENT_PORTAL,
    projectId: PROJECT_ID,
    secureCookies: false,
  };
  const builds: Record<string, (origin: string, limited: boolean) => Handler> = {
    'tenant portal': (origin, limited) =>
      createTenantPortal({
        ...common,
        publicOrigin: origin,
        allowedOrgIds: new Set(['org-x']),
        db: {} as TenantDb,
        ...(limited ? { trustedProxies: parseTrustedProxies(EDGE) } : {}),
      }),
    'owner console': (origin, limited) =>
      createOwnerConsole({
        ...common,
        publicOrigin: origin,
        ownerOrgId: 'org-owner',
        db: {} as OwnerDb,
        ...(limited ? { trustedProxies: parseTrustedProxies(EDGE) } : {}),
      }),
  };

  for (const [name, build] of Object.entries(builds)) {
    it(`limits the ${name} when given trusted proxies, and only then`, async () => {
      const limited = await serve((origin) => build(origin, true));
      const open = await serve((origin) => build(origin, false));
      try {
        await repeat(limited, '/login', LIMIT, () => forwardedFor(CLIENT_A));
        expect((await ask(limited, '/login', forwardedFor(CLIENT_A))).status).toBe(429);
        await repeat(open, '/login', LIMIT, () => forwardedFor(CLIENT_A));
        expect((await ask(open, '/login', forwardedFor(CLIENT_A))).status).toBe(302);
      } finally {
        await limited.close();
        await open.close();
      }
    });
  }
});
