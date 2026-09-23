import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainRouter } from '../../../src/routes/drain.js';
import { createDrainWake, type DrainWake } from '../../../src/drainWake.js';
import { createTestLogger, type TestLogger } from '../../helpers/testLogger.js';
import { createUnlimitedThrottle } from '../../helpers/testThrottle.js';
import type { Throttle } from '../../../src/throttle.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { startRouter, type StartedRouter } from '../helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const DRAIN_TOKEN = 'the-drain-token';

const FAST_OPTIONS = {
  holdMs: 80,
  leaseSeconds: 30,
  batchLimit: 10,
  pollIntervalMs: 10,
};

function payload() {
  return {
    from: 'noreply@tenant1.example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    headers: {},
    recipientVariables: {},
  };
}

describe('GET /drain, POST /drain/ack', () => {
  let store: FakeShimStore;
  let wake: DrainWake;
  let testLogger: TestLogger;
  let server: StartedRouter;

  async function start(throttle: Throttle = createUnlimitedThrottle()): Promise<void> {
    server = await startRouter(
      createDrainRouter(store, wake, DRAIN_TOKEN, FAST_OPTIONS, testLogger.logger, throttle)
    );
  }

  beforeEach(() => {
    store = createFakeStore();
    wake = createDrainWake();
    testLogger = createTestLogger();
  });

  afterEach(async () => {
    await server.close();
  });

  it('401s GET /drain with no Authorization header', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain`);
    expect(res.status).toBe(401);
  });

  it('401s GET /drain with the wrong bearer token', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: 'Bearer not-the-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('401s POST /drain/ack with no Authorization header, and acks nothing', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);

    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [drained!.id] }),
    });
    expect(res.status).toBe(401);
    // Still held — the unauthenticated ack must not have taken effect.
    expect(store.ackDrain([drained!.id], 1).acked).toEqual([drained!.id]);
  });

  it('returns an empty message list once the hold expires with nothing queued', async () => {
    await start();
    const start_ = Date.now();
    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const elapsed = Date.now() - start_;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(elapsed).toBeGreaterThanOrEqual(FAST_OPTIONS.holdMs - 15);
  });

  it('returns immediately with whatever is already claimable, without waiting out the hold', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });

    const start_ = Date.now();
    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const elapsed = Date.now() - start_;
    const body = (await res.json()) as { messages: Array<{ to: string; id: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.to).toBe('member@example.com');
    expect(elapsed).toBeLessThan(FAST_OPTIONS.holdMs);
  });

  it('a held GET /drain is woken by drainWake.notify() well before the hold expires', async () => {
    await start();
    const drainPromise = fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });

    await new Promise((r) => setTimeout(r, 20));
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const start_ = Date.now();
    wake.notify();

    const res = await drainPromise;
    const elapsed = Date.now() - start_;
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
    // Well under the hold, and under even one poll interval — this is what
    // proves the wake fired the query rather than the poll loop happening
    // to land on it.
    expect(elapsed).toBeLessThan(FAST_OPTIONS.pollIntervalMs + 20);
  });

  it('POST /drain/ack rejects a body missing "ids" with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects a literal JSON null body with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects an empty "ids" array with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects "ids" containing a non-string with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['real-id', 42] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack reports acked/alreadyHandled/unknown for a mixed batch of ids', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com'],
      now: 0,
    });
    const [rowA, rowB] = store.claimForDrain(0, 30, 10);

    // Pre-ack b so the route call below sees it as alreadyHandled.
    store.ackDrain([rowB!.id], 1);

    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [rowA!.id, rowB!.id, 'never-issued'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acked: string[];
      alreadyHandled: string[];
      unknown: string[];
    };
    expect(body.acked).toEqual([rowA!.id]);
    expect(body.alreadyHandled).toEqual([rowB!.id]);
    expect(body.unknown).toEqual(['never-issued']);
  });

  it('a throttle refusing every token means GET /drain hands over nothing, even with mail queued — the throttle is genuinely wired into the claim, not decorative', async () => {
    const zeroThrottle: Throttle = {
      tryTake: () => false,
      reload: () => {
        // nothing to reload
      },
      currentRate: () => 0,
    };
    await start(zeroThrottle);
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });

    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
    // Still queued — the throttle held it back rather than dropping it.
    expect(store.countUndrainedRecipients()).toBe(1);
  });
});
