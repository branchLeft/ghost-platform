import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Transporter } from '../../src/smtp.js';
import { createFakeStore, type FakeShimStore } from './helpers/fakeStore.js';
import { basicAuthHeader, type StartedRouter } from './helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';

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

describe('createApp — wires all three Mailgun-shaped routers at the root', () => {
  let store: FakeShimStore;
  let transport: Transporter;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    transport = { sendMail: vi.fn(async () => ({})) } as unknown as Transporter;
    server = await listenApp(createApp(store, transport));
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
});
