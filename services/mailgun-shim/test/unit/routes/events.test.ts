import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventsRouter } from '../../../src/routes/events.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';

interface WireEvent {
  event: string;
  recipient: string;
  message: { headers: { 'message-id'?: string } };
  'user-variables': { 'email-id'?: string };
  paging?: never;
}

interface WireEventsResponse {
  items: WireEvent[];
  paging: { next: string; previous: string; first: string; last: string };
}

describe('GET /v3/:domain/events', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    server = await startRouter(createEventsRouter(store));
  });

  afterEach(async () => {
    await server.close();
  });

  function get(path: string) {
    return fetch(`${server.baseUrl}${path}`, {
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
  }

  it("includes both message.headers.message-id and user-variables.email-id — Ghost's normalizeEvent needs both", async () => {
    store.recordEvent({
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: 'email-record-42',
      providerMessageId: '<abc123@tenant1.example.com>',
      timestamp: Date.now() / 1000,
      errorCode: null,
      errorMessage: null,
    });

    const res = await get(`/v3/${DOMAIN}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireEventsResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.message.headers['message-id']).toBe('<abc123@tenant1.example.com>');
    expect(body.items[0]!['user-variables']['email-id']).toBe('email-record-42');
  });

  it('filters using the OR-joined event query param the way Ghost sends it', async () => {
    for (const type of ['delivered', 'opened', 'failed']) {
      store.recordEvent({
        domain: DOMAIN,
        type,
        severity: null,
        recipient: `${type}@example.com`,
        emailId: null,
        providerMessageId: null,
        timestamp: Date.now() / 1000,
        errorCode: null,
        errorMessage: null,
      });
    }

    const res = await get(`/v3/${DOMAIN}/events?event=delivered OR failed`);
    const body = (await res.json()) as WireEventsResponse;
    expect(body.items.map((i) => i.event).sort()).toEqual(['delivered', 'failed']);
  });

  it('paginates via the cursor as an extra path segment (mailgun.js appends page.next.page, not a query param)', async () => {
    for (let i = 0; i < 5; i += 1) {
      store.recordEvent({
        domain: DOMAIN,
        type: 'delivered',
        severity: null,
        recipient: `member-${i}@example.com`,
        emailId: null,
        providerMessageId: null,
        timestamp: Date.now() / 1000,
        errorCode: null,
        errorMessage: null,
      });
    }

    const first = (await (await get(`/v3/${DOMAIN}/events?limit=2`)).json()) as WireEventsResponse;
    expect(first.items).toHaveLength(2);
    const nextCursor = new URL(first.paging.next).pathname.split('/').pop();

    // The emitted paging.next URL carries the cursor as a path segment only
    // (no query string) — a real paginating client re-supplies limit itself
    // on every request, same as mailgun.js's #fetchEventsFromDomain loop.
    const second = (await (
      await get(`/v3/${DOMAIN}/events/${nextCursor}?limit=2`)
    ).json()) as WireEventsResponse;
    expect(second.items).toHaveLength(2);
    expect(second.items[0]!.recipient).not.toBe(first.items[0]!.recipient);
  });

  it('a garbage (non-numeric) cursor is treated as offset 0 rather than erroring', async () => {
    store.recordEvent({
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: Date.now() / 1000,
      errorCode: null,
      errorMessage: null,
    });

    const res = await get(`/v3/${DOMAIN}/events/not-a-number`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireEventsResponse;
    expect(body.items).toHaveLength(1);
  });

  it('final page: once events are exhausted, items is empty and next does not advance the cursor', async () => {
    store.recordEvent({
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: Date.now() / 1000,
      errorCode: null,
      errorMessage: null,
    });

    const res = await get(`/v3/${DOMAIN}/events/50`);
    const body = (await res.json()) as WireEventsResponse;
    expect(body.items).toEqual([]);
  });

  it('401s without valid tenant credentials', async () => {
    const res = await fetch(`${server.baseUrl}/v3/${DOMAIN}/events`, {
      headers: { Authorization: basicAuthHeader('api', 'wrong-key') },
    });
    expect(res.status).toBe(401);
  });
});
