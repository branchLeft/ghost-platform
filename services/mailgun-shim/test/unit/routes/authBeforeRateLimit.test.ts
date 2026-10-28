import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainWake } from '../../../src/drainWake.js';
import { createEventsRouter } from '../../../src/routes/events.js';
import { createMessagesRouter } from '../../../src/routes/messages.js';
import { createSuppressionsRouter } from '../../../src/routes/suppressions.js';
import { createTestLogger } from '../../helpers/testLogger.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';

// The per-tenant limits the routes are built with, each per 60 seconds.
// The tests send one more request than the limit, so the limiter's 429
// would show on the last one if it counted the requests that fail
// authentication.
const SEND_LIMIT = 60;
const EVENTS_LIMIT = 120;

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';
const OTHER_DOMAIN = 'tenant2.example.com';
const OTHER_KEY = 'tenant2-api-key';
const WRONG_KEY = 'not-the-right-key';
const MEMBER = 'member@example.com';

function validSend(domain: string): FormData {
  const form = new FormData();
  form.append('to', MEMBER);
  form.append('from', `noreply@${domain}`);
  form.append('subject', 'Hi');
  form.append('html', '<p>hi</p>');
  form.append('text', 'hi');
  form.append('recipient-variables', '{}');
  return form;
}

/**
 * Sends requests one after another and returns each status. Each body is
 * drained before the next request, so the connection is reused and a
 * rejected request cannot leave unread bytes behind.
 */
async function statusesOf(count: number, send: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    statuses.push(await statusOf(send));
  }
  return statuses;
}

async function statusOf(send: () => Promise<Response>): Promise<number> {
  const res = await send();
  await res.arrayBuffer();
  return res.status;
}

function repeat(status: number, count: number): number[] {
  return Array.from({ length: count }, () => status);
}

describe('POST /v3/:domain/messages: authentication before the rate limit', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    store.registerTenant(OTHER_DOMAIN, OTHER_KEY, OTHER_DOMAIN);
    const testLogger = createTestLogger();
    server = await startRouter(createMessagesRouter(store, createDrainWake(), testLogger.logger));
  });

  afterEach(async () => {
    await server.close();
  });

  function post(authorization: string | undefined, domain = DOMAIN) {
    return fetch(`${server.baseUrl}/v3/${domain}/messages`, {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
      body: validSend(domain),
    });
  }

  it('T1 a wrong key gets 401 on every send, none is rate limited, and a valid send then returns 200', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    const statuses = await statusesOf(SEND_LIMIT + 1, () => post(bad));
    expect(statuses).toEqual(repeat(401, SEND_LIMIT + 1));

    expect(await statusOf(() => post(basicAuthHeader('api', API_KEY)))).toBe(200);
  });

  it('T2 a send with no Authorization header gets 401 every time, none is rate limited, and a valid send then returns 200', async () => {
    const statuses = await statusesOf(SEND_LIMIT + 1, () => post(undefined));
    expect(statuses).toEqual(repeat(401, SEND_LIMIT + 1));

    expect(await statusOf(() => post(basicAuthHeader('api', API_KEY)))).toBe(200);
  });

  it('T7 an authenticated caller gets 200 for the first 60 sends and 429 on the 61st', async () => {
    const good = basicAuthHeader('api', API_KEY);
    const statuses = await statusesOf(SEND_LIMIT + 1, () => post(good));
    expect(statuses).toEqual([...repeat(200, SEND_LIMIT), 429]);
  });

  it('T9 bad credentials aimed at one tenant do not spend another tenant budget', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    await statusesOf(SEND_LIMIT + 1, () => post(bad, DOMAIN));

    expect(await statusOf(() => post(basicAuthHeader('api', OTHER_KEY), OTHER_DOMAIN))).toBe(200);
  });
});

describe('GET /v3/:domain/events: authentication before the rate limit', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    server = await startRouter(createEventsRouter(store));
  });

  afterEach(async () => {
    await server.close();
  });

  function get(path: string, authorization: string | undefined) {
    return fetch(`${server.baseUrl}${path}`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
  }

  it('T3 on the bare events path, a wrong key gets 401 on every read, and a valid read then returns 200', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    const statuses = await statusesOf(EVENTS_LIMIT + 1, () => get(`/v3/${DOMAIN}/events`, bad));
    expect(statuses).toEqual(repeat(401, EVENTS_LIMIT + 1));

    const good = basicAuthHeader('api', API_KEY);
    expect(await statusOf(() => get(`/v3/${DOMAIN}/events`, good))).toBe(200);
  });

  it('T4 on the cursor events path, a wrong key gets 401 on every read, and a valid read then returns 200', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    const statuses = await statusesOf(EVENTS_LIMIT + 1, () => get(`/v3/${DOMAIN}/events/50`, bad));
    expect(statuses).toEqual(repeat(401, EVENTS_LIMIT + 1));

    const good = basicAuthHeader('api', API_KEY);
    expect(await statusOf(() => get(`/v3/${DOMAIN}/events/50`, good))).toBe(200);
  });

  it('T5 the bare and cursor paths share one budget, so 401s split across both paths spend none of it and a valid read on each path returns 200', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    let turn = 0;
    const statuses = await statusesOf(EVENTS_LIMIT + 1, () => {
      const path = turn % 2 === 0 ? `/v3/${DOMAIN}/events` : `/v3/${DOMAIN}/events/50`;
      turn += 1;
      return get(path, bad);
    });
    expect(statuses).toEqual(repeat(401, EVENTS_LIMIT + 1));

    const good = basicAuthHeader('api', API_KEY);
    expect(await statusOf(() => get(`/v3/${DOMAIN}/events`, good))).toBe(200);
    expect(await statusOf(() => get(`/v3/${DOMAIN}/events/50`, good))).toBe(200);
  });

  it('T8 an authenticated caller gets 200 for the first 120 reads and 429 on the 121st', async () => {
    const good = basicAuthHeader('api', API_KEY);
    const statuses = await statusesOf(EVENTS_LIMIT + 1, () => get(`/v3/${DOMAIN}/events`, good));
    expect(statuses).toEqual([...repeat(200, EVENTS_LIMIT), 429]);
  });
});

describe('DELETE /v3/:domain/:type/:email: authentication before the rate limit', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    server = await startRouter(createSuppressionsRouter(store));
  });

  afterEach(async () => {
    await server.close();
  });

  function del(authorization: string) {
    return fetch(`${server.baseUrl}/v3/${DOMAIN}/bounces/${encodeURIComponent(MEMBER)}`, {
      method: 'DELETE',
      headers: { Authorization: authorization },
    });
  }

  it('T6 a wrong key gets 401 on every suppression delete, none is rate limited, and a valid delete then returns 200', async () => {
    const bad = basicAuthHeader('api', WRONG_KEY);
    const statuses = await statusesOf(SEND_LIMIT + 1, () => del(bad));
    expect(statuses).toEqual(repeat(401, SEND_LIMIT + 1));

    expect(await statusOf(() => del(basicAuthHeader('api', API_KEY)))).toBe(200);
  });
});
