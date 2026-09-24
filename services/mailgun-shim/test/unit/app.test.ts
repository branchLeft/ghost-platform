import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Interfaces } from 'mailgun.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Transporter } from '../../src/smtp.js';
import type { WorkerHandle } from '../../src/worker.js';
import { createMailgunClient } from '../helpers/mailgunClient.js';
import { createTestWorker } from '../helpers/testWorker.js';
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

describe('createApp — wires all three Mailgun-shaped routers plus healthz at the root', () => {
  let store: FakeShimStore;
  let transport: Transporter;
  let worker: WorkerHandle;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    transport = { sendMail: vi.fn(async () => ({})) } as unknown as Transporter;
    worker = createTestWorker(store, transport);
    server = await listenApp(createApp(store, worker));
  });

  afterEach(async () => {
    await worker.stop();
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

  it('serves an unauthenticated healthz with the pending queue count and worker liveness', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      pending: number;
      workerLastTickAt: number | null;
      workerStopped: boolean;
    };
    expect(body.status).toBe('ok');
    expect(body.pending).toBe(0);
    // The startup drain has already completed by the time this request
    // lands — a null here would mean the worker never ticked at all.
    expect(body.workerLastTickAt).toEqual(expect.any(Number));
    expect(body.workerStopped).toBe(false);
  });

  it("healthz 500s if the store can't be reached", async () => {
    const pingSpy = vi.spyOn(store, 'ping').mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const res = await fetch(`${server.baseUrl}/healthz`);
    expect(res.status).toBe(500);
    pingSpy.mockRestore();
  });
});

describe('POST /v3/:domain/messages — Ghost bulk newsletter batches', () => {
  let store: FakeShimStore;
  let sendMail: ReturnType<typeof vi.fn>;
  let transport: Transporter;
  let worker: WorkerHandle;
  let server: StartedRouter;
  let mailgunClient: Interfaces.IMailgunClient;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    sendMail = vi.fn(async () => ({}));
    transport = { sendMail } as unknown as Transporter;
    worker = createTestWorker(store, transport);
    server = await listenApp(createApp(store, worker));
    mailgunClient = createMailgunClient(server.baseUrl, API_KEY);
  });

  afterEach(async () => {
    await worker.stop();
    await server.close();
  });

  it("accepts a 1,000-recipient send — Ghost's own DEFAULT_BATCH_SIZE for a newsletter — and queues every recipient", async () => {
    const recipientData: Record<string, { name: string }> = {};
    for (let i = 0; i < 1000; i += 1) {
      recipientData[`member-${i}@example.com`] = { name: `Member ${i}` };
    }

    // Driven through mailgun.js, the exact client library Ghost bundles,
    // so this exercises the real wire format rather than a guess at it —
    // to[], recipient-variables, v:email-id and o:tag are what
    // MailgunClient#send actually sends for a bulk newsletter batch.
    const response = await mailgunClient.messages.create(DOMAIN, {
      to: Object.keys(recipientData),
      from: 'TENANT_1 <noreply@tenant1.example.com>',
      subject: 'Hello %recipient.name%',
      html: '<p>Hi %recipient.name%</p>',
      text: 'Hi %recipient.name%',
      'recipient-variables': JSON.stringify(recipientData),
      'v:email-id': 'email-record-bulk-1000',
      'o:tag': ['bulk-email', 'ghost-email'],
    });

    expect(response.id).toBeTruthy();

    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1000);
  }, 30000);
});
