import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createDrainApp, createMailApp } from '../../src/app.js';
import { createDrainWake, type DrainWake } from '../../src/drainWake.js';
import { createUnlimitedThrottle } from '../helpers/testThrottle.js';
import { createFakeStore, type FakeShimStore } from './helpers/fakeStore.js';
import { basicAuthHeader, type StartedRouter } from './helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';
const DRAIN_TOKEN = 'the-drain-token';

const DRAIN_OPTIONS = {
  holdMs: 50,
  leaseSeconds: 30,
  batchLimit: 25,
  pollIntervalMs: 10,
};

// createApp returns a full Express app (not a bare Router) — it already
// knows how to listen on its own, so it's started directly rather than via
// the startRouter helper, which wraps a Router in a second outer app.
// Nesting it under a second app would mean the OUTER app's own
// x-powered-by-enabled init middleware runs first and sets the header
// regardless of what createApp configured on its own (inner) app instance.
function listenApp(app: ReturnType<typeof createApp>): Promise<StartedRouter> {
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

describe('createApp — wires the Mailgun-shaped routers, the drain handover, healthz and metrics at the root', () => {
  let store: FakeShimStore;
  let wake: DrainWake;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    wake = createDrainWake();
    server = await listenApp(
      createApp(store, wake, DRAIN_TOKEN, DRAIN_OPTIONS, createUnlimitedThrottle())
    );
  });

  afterEach(async () => {
    await server.close();
  });

  it('mounts the events route at the app root (no path prefix)', async () => {
    const res = await fetch(`${server.baseUrl}/v3/${DOMAIN}/events`, {
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
    expect(res.status).toBe(200);
  });

  it('mounts the suppressions route at the app root', async () => {
    const res = await fetch(
      `${server.baseUrl}/v3/${DOMAIN}/bounces/${encodeURIComponent('a@example.com')}`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuthHeader('api', API_KEY) },
      }
    );
    expect(res.status).toBe(200);
  });

  it('mounts the drain handover at the app root, behind its own bearer token', async () => {
    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('disables the X-Powered-By header', async () => {
    const res = await fetch(`${server.baseUrl}/v3/${DOMAIN}/events`, {
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('an unmatched path 404s rather than falling through to any router silently', async () => {
    const res = await fetch(`${server.baseUrl}/not-a-real-path`);
    expect(res.status).toBe(404);
  });

  it('serves an unauthenticated healthz with the undrained recipient count', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; undrained: number };
    expect(body.status).toBe('ok');
    expect(body.undrained).toBe(0);
  });

  it("healthz 500s if the store can't be reached", async () => {
    const pingSpy = vi.spyOn(store, 'ping').mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const res = await fetch(`${server.baseUrl}/healthz`);
    expect(res.status).toBe(500);
    pingSpy.mockRestore();
  });

  it('serves an unauthenticated /metrics with the producer-side oldest-undrained-age gauge', async () => {
    const res = await fetch(`${server.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('mailgun_shim_oldest_undrained_age_seconds 0');
    expect(body).toContain('mailgun_shim_undrained_recipients 0');
  });
});

describe('the split listeners — /drain exists on the drain app alone', () => {
  let store: FakeShimStore;
  let wake: DrainWake;
  let mail: StartedRouter;
  let drain: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    wake = createDrainWake();
    mail = await listenApp(createMailApp(store, wake));
    drain = await listenApp(
      createDrainApp(store, wake, DRAIN_TOKEN, DRAIN_OPTIONS, createUnlimitedThrottle())
    );
  });

  afterEach(async () => {
    await mail.close();
    await drain.close();
  });

  const bearer = { Authorization: `Bearer ${DRAIN_TOKEN}` };

  it.each([
    ['GET', '/drain'],
    ['POST', '/drain/ack'],
    ['POST', '/drain/outcomes'],
  ])('the mail listener 404s %s %s even with the right drain token', async (method, path) => {
    const res = await fetch(`${mail.baseUrl}${path}`, {
      method,
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(404);
  });

  it('the mail listener still serves the Mailgun-shaped API, healthz and metrics', async () => {
    const events = await fetch(`${mail.baseUrl}/v3/${DOMAIN}/events`, {
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
    expect(events.status).toBe(200);
    expect((await fetch(`${mail.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${mail.baseUrl}/metrics`)).status).toBe(200);
  });

  it('the drain listener serves the drain handover behind its bearer token', async () => {
    expect((await fetch(`${drain.baseUrl}/drain`)).status).toBe(401);
    const res = await fetch(`${drain.baseUrl}/drain`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('the drain listener serves no Mailgun-shaped route', async () => {
    const events = await fetch(`${drain.baseUrl}/v3/${DOMAIN}/events`, {
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
    expect(events.status).toBe(404);
    const send = await fetch(`${drain.baseUrl}/v3/${DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
    expect(send.status).toBe(404);
  });

  it('the drain listener keeps healthz and metrics, which the host-side probe reads', async () => {
    expect((await fetch(`${drain.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${drain.baseUrl}/metrics`)).status).toBe(200);
  });
});
