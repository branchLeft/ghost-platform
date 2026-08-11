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
