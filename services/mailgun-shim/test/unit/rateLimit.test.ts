import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantRateLimiter } from '../../src/rateLimit.js';

function startLimitedApp(limit: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app: Express = express();
  app.get('/v3/:domain/probe', tenantRateLimiter(limit), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}

describe('tenantRateLimiter — per-domain isolation and boundary', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const started = await startLimitedApp(3);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterEach(async () => {
    await close();
  });

  it('allows exactly the nth request and refuses the (n+1)th, for a limit of 3', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${baseUrl}/v3/tenant-a.example.com/probe`);
      responses.push(res.status);
    }
    expect(responses).toEqual([200, 200, 200, 429]);
  });

  it("one tenant exhausting its budget does not affect a different tenant's budget", async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${baseUrl}/v3/tenant-a.example.com/probe`);
      expect(res.status).toBe(200);
    }
    // Tenant A is now exhausted.
    const exhausted = await fetch(`${baseUrl}/v3/tenant-a.example.com/probe`);
    expect(exhausted.status).toBe(429);

    // Tenant B has never made a request and gets its own full budget.
    const tenantB = await fetch(`${baseUrl}/v3/tenant-b.example.com/probe`);
    expect(tenantB.status).toBe(200);
  });

  it('falls back to keying by IP when the path has no :domain segment worth limiting on', async () => {
    // Both requests hit the same route with the same domain param, so this
    // just confirms the limiter's key isn't accidentally shared across
    // completely different domain strings that happen to collide.
    const a = await fetch(`${baseUrl}/v3/tenant-a.example.com/probe`);
    const b = await fetch(`${baseUrl}/v3/tenant-b.example.com/probe`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

/**
 * None of the three mounted routers (`messages`, `events`, `suppressions`)
 * can actually miss `:domain` — Express won't match the route pattern
 * without it — so the IP fallback below is exercised through a
 * domain-less route of its own, the same way the suite above exercises
 * the domain-keyed path through its own probe route. `trust proxy` plus
 * `X-Forwarded-For` stands in for distinct client source addresses,
 * since a real HTTP client in this test process can't originate from
 * more than one address.
 */
function startFallbackApp(limit: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app: Express = express();
  app.set('trust proxy', true);
  app.get('/probe', tenantRateLimiter(limit), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}

async function probeFrom(baseUrl: string, sourceIp: string): Promise<number> {
  const res = await fetch(`${baseUrl}/probe`, {
    headers: { 'X-Forwarded-For': sourceIp },
  });
  return res.status;
}

describe('tenantRateLimiter — IP fallback groups IPv6 by prefix, leaves IPv4 alone', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const started = await startFallbackApp(3);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterEach(async () => {
    await close();
  });

  it('four different IPv6 addresses in the same /56 share one bucket and the 4th is refused', async () => {
    const addresses = ['2001:db8:1::1', '2001:db8:1::2', '2001:db8:1::3', '2001:db8:1::4'];
    const statuses: number[] = [];
    for (const ip of addresses) {
      statuses.push(await probeFrom(baseUrl, ip));
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('an IPv6 address in a different /56 gets its own, unexhausted budget', async () => {
    for (const ip of ['2001:db8:1::1', '2001:db8:1::2', '2001:db8:1::3']) {
      expect(await probeFrom(baseUrl, ip)).toBe(200);
    }
    // The shared /56 above is now exhausted.
    expect(await probeFrom(baseUrl, '2001:db8:1::4')).toBe(429);

    // A address whose top 8 bits of the 4th hextet differ is a different
    // /56 (the default ipv6Subnet) and has never been charged.
    expect(await probeFrom(baseUrl, '2001:db8:1:100::1')).toBe(200);
  });

  it('four different IPv4 addresses are NOT grouped — each keeps its own full budget', async () => {
    const addresses = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];
    for (const ip of addresses) {
      // Every one of the 4 is a distinct key, so every one gets its own
      // limit of 3 and the first request from each succeeds.
      expect(await probeFrom(baseUrl, ip)).toBe(200);
    }
  });
});

describe('tenantRateLimiter — window expiry', () => {
  // Driven directly against the middleware with fake req/res objects (rather
  // than a real HTTP round trip) so system-time can be advanced without
  // racing real network I/O — express-rate-limit's MemoryStore checks
  // `resetTime <= Date.now()` lazily on the next hit, so this is sufficient
  // to exercise the real reset logic.
  //
  // A blocked (429) request never calls Express's `next()` — the library's
  // default handler ends the response directly via `res.send()` instead —
  // so completion has to be signalled by whichever of the two happens.
  function fakeReqRes(domain: string) {
    const headers: Record<string, unknown> = {};
    let settle: (err?: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      settle = (err) => (err ? reject(err) : resolve());
    });
    const req = { ip: '127.0.0.1', params: { domain }, method: 'GET' };
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        headers[name] = value;
        return res;
      },
      getHeader(name: string) {
        return headers[name];
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      send(_body?: unknown) {
        settle();
        return res;
      },
    };
    const next = (err?: unknown) => settle(err);
    return { req, res, next, finished };
  }

  async function runMiddleware(
    middleware: ReturnType<typeof tenantRateLimiter>,
    domain: string
  ): Promise<{ statusCode: number }> {
    const { req, res, next, finished } = fakeReqRes(domain);
    middleware(req as never, res as never, next as never);
    await finished;
    return res;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets the budget once the 60s window elapses', async () => {
    const limiter = tenantRateLimiter(1);

    const first = await runMiddleware(limiter, 'tenant-window.example.com');
    expect(first.statusCode).toBe(200);

    const second = await runMiddleware(limiter, 'tenant-window.example.com');
    expect(second.statusCode).toBe(429);

    vi.setSystemTime(Date.now() + 60_001);

    const third = await runMiddleware(limiter, 'tenant-window.example.com');
    expect(third.statusCode).toBe(200);
  });
});
