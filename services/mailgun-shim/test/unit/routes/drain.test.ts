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
      body: JSON.stringify({ acks: [{ id: drained!.id, drainCount: drained!.drainCount }] }),
    });
    expect(res.status).toBe(401);
    // Still held — the unauthenticated ack must not have taken effect.
    expect(store.ackDrain([{ id: drained!.id, drainCount: drained!.drainCount }], 1).acked).toEqual(
      [drained!.id]
    );
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

  it('POST /drain/ack rejects a body missing "acks" with 400', async () => {
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

  it('POST /drain/ack rejects a body that is valid JSON but not an object at all (a bare string) with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: '"just a string"',
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects an "acks" array containing a literal null entry with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [null] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects an empty "acks" array with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects an entry with a non-string id with 400', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [{ id: 42, drainCount: 1 }] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects an entry missing drainCount with 400 — it is required, never defaulted', async () => {
    await start();
    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [{ id: 'real-id' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /drain/ack rejects a non-positive-integer drainCount with 400', async () => {
    await start();
    for (const badCount of [0, -1, 1.5, '1']) {
      const res = await fetch(`${server.baseUrl}/drain/ack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ acks: [{ id: 'real-id', drainCount: badCount }] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('POST /drain/ack reports acked/alreadyHandled/unknown for a mixed batch', async () => {
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
    store.ackDrain([{ id: rowB!.id, drainCount: rowB!.drainCount }], 1);

    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acks: [
          { id: rowA!.id, drainCount: rowA!.drainCount },
          { id: rowB!.id, drainCount: rowB!.drainCount },
          { id: 'never-issued', drainCount: 1 },
        ],
      }),
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

  it('POST /drain/ack reports unknown for a stale drainCount — a late ack from a claim the lease has already superseded', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [firstClaim] = store.claimForDrain(0, 30, 10);
    // Lease lapses; re-offered to a second claim under a new drainCount —
    // simulated directly against the store, the same way the real GET
    // /drain loop would produce it after 30s.
    const [secondClaim] = store.claimForDrain(31, 30, 10);
    expect(secondClaim!.id).toBe(firstClaim!.id);
    expect(secondClaim!.drainCount).toBeGreaterThan(firstClaim!.drainCount);

    const res = await fetch(`${server.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acks: [{ id: firstClaim!.id, drainCount: firstClaim!.drainCount }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acked: string[];
      alreadyHandled: string[];
      unknown: string[];
    };
    expect(body).toEqual({ acked: [], alreadyHandled: [], unknown: [firstClaim!.id] });
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

  it("an aborted GET /drain never claims a message on the abandoned connection's behalf, even once one becomes available while it was held", async () => {
    await start();

    const controller = new AbortController();
    const drainPromise = fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
      signal: controller.signal,
    });
    // Let the request actually reach the held-open poll loop before
    // aborting it — the loop is waiting on wake.waitForSignal() at this
    // point, with nothing yet queued.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(drainPromise).rejects.toThrow();
    // The server's own req 'close' event fires once the OS reports the
    // connection actually gone, not the instant the client-side abort
    // signal fires — give it a moment to arrive before proceeding, the
    // same gap any real disconnect (not just an abort()) has.
    await new Promise((r) => setTimeout(r, 30));

    // Something becomes available only AFTER the abort — exactly the
    // ordering that would let an unguarded loop claim it for a connection
    // that can never receive the response.
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    wake.notify();

    // Give the aborted request's own loop every chance to (wrongly) wake
    // and claim before checking — it must not have.
    await new Promise((r) => setTimeout(r, FAST_OPTIONS.holdMs + 40));

    // A fresh, un-aborted request finds the message completely untouched:
    // drainCount 1, not 2 — proof nothing claimed it in between.
    const freshRes = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const freshBody = (await freshRes.json()) as { messages: Array<{ drainCount: number }> };
    expect(freshBody.messages).toHaveLength(1);
    expect(freshBody.messages[0]!.drainCount).toBe(1);
  });

  it('carries the recipient-variables "name" as toName, separate from the bare address in "to"', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: {
        ...payload(),
        recipientVariables: { 'member@example.com': { name: 'Member Name' } },
      },
      recipients: ['member@example.com'],
      now: 0,
    });

    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const body = (await res.json()) as { messages: Array<{ to: string; toName?: string }> };
    expect(body.messages[0]!.to).toBe('member@example.com');
    expect(body.messages[0]!.toName).toBe('Member Name');
  });

  it('leaves toName undefined when recipient-variables carries no name for that recipient', async () => {
    await start();
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
    const body = (await res.json()) as { messages: Array<{ toName?: string }> };
    expect(body.messages[0]!.toName).toBeUndefined();
  });

  // Intake (mailgunFields.ts) drops every h:* key that normalises to
  // 'Sender' before a batch is ever enqueued, so a row this route reads
  // back can never carry one under normal operation. This proves
  // toWireMessage's own narrower defence for a row that predates that
  // intake change — the exact literal key Ghost itself always sends — by
  // writing a payload straight into the store, bypassing intake entirely,
  // the way such a legacy row would already exist on disk. toWireMessage
  // is the direct successor of the deleted worker.ts's processRow; this is
  // the drain-world equivalent of that file's own now-deleted test.
  it('strips a stored "Sender" header (the one exact spelling it still special-cases) before it reaches the wire message', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: {
        ...payload(),
        headers: { Sender: 'ceo@evil.example', 'X-Custom': 'kept' },
      },
      recipients: ['member@example.com'],
      now: 0,
    });

    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const body = (await res.json()) as { messages: Array<{ headers: Record<string, string> }> };
    expect(body.messages[0]!.headers).toEqual({ 'X-Custom': 'kept' });
  });

  // `from` must never be %recipient.*%-substituted the way a Sender
  // header's value used to be able to be (the class of bug a foreign
  // %recipient.*% token in Sender used to exploit) — it is the value the
  // intake check already approved, and resolving a token in it here would
  // let an approved value turn into a different, unchecked one on the
  // wire. A real matching recipientVariables entry is provided so a
  // wired-in substitution would visibly change `from`, and a control field
  // (subject) in the same message proves the token machinery is live for
  // this send — `from` staying literal is a real negative, not an
  // artefact of an empty variables map.
  it('never resolves a %recipient.*% token inside `from`, unlike subject in the same message', async () => {
    await start();
    store.enqueueBatch({
      batchId: 'b1',
      domain: DOMAIN,
      emailId: null,
      payload: {
        ...payload(),
        from: 'blog+%recipient.token%@tenant1.example.com',
        subject: 'Hi %recipient.token%',
        recipientVariables: { 'member@example.com': { token: 'evil' } },
      },
      recipients: ['member@example.com'],
      now: 0,
    });

    const res = await fetch(`${server.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    const body = (await res.json()) as { messages: Array<{ from: string; subject: string }> };
    expect(body.messages[0]!.subject).toBe('Hi evil');
    expect(body.messages[0]!.from).toBe('blog+%recipient.token%@tenant1.example.com');
  });
});
