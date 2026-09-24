import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashIdOf,
  parseSlotLeaseRecord,
  type EmailAddress,
  type Slug,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import { demoDescriptor, tenantDescriptorFixture } from '../helpers/fixtures.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';

describe('the broker HTTP endpoints (LLD-2 §03)', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  // --- "portal"-shaped proof: reconcile a fresh slot, poll status, reset it. ---
  it('portal: reconciles a fresh slot, observes it running via /status, then resets it', async () => {
    broker = await startTestBroker();
    const descriptor = demoDescriptor();

    const reconcileRes = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor });
    expect(reconcileRes.status).toBe(200);
    expect(await reconcileRes.json()).toEqual({ slot: '0', phase: 'running', colour: 'a' });

    // /status is deliberately unauthenticated (LLD-2 §03) -- plain fetch, no signing.
    const statusRes = await fetch(`${broker.baseUrl}/status/0`);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ slot: '0', phase: 'running', healthy: false });
    // healthy is false because nothing is really listening on the sidecar's
    // health port in this sandbox -- proven distinctly by
    // healthCheck.test.ts against a real fake sidecar; this test's job is
    // the wiring, not re-proving that unit.

    const resetRes = await broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(resetRes.status).toBe(200);
    expect(await resetRes.json()).toEqual({ slot: '0', phase: 'free' });

    const statusAfterReset = await fetch(`${broker.baseUrl}/status/0`);
    expect(await statusAfterReset.json()).toEqual({ slot: '0', phase: 'free', healthy: false });
  });

  it('reconcile drives the wrapper, the renderer and the admin API in order, and writes the lease/hash contract', async () => {
    broker = await startTestBroker();
    const descriptor = demoDescriptor({ slug: 'demo-recycle' as Slug });

    const res = await broker.signedFetch('POST', '/reconcile', { slot: '2', descriptor });
    expect(res.status).toBe(200);

    expect(broker.renderer.calls).toHaveLength(1);
    expect(broker.adminApi.calls).toHaveLength(1);
    expect(broker.adminApi.calls[0]?.baseUrl).toBe(`http://127.0.0.1:${descriptor.ports.a}`);

    const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(invocations).toEqual([['2', 'a', 'start']]);

    // The recycle contract this story was told to honour verbatim
    // (workspace#1302 comment 5799768388 / render-core/src/lease.ts):
    // the lease record's hashId is hashIdOf() of the exact hash written to
    // the slots file for this host.
    const leaseText = await readFile(`${broker.leaseDir}/2.json`, 'utf8');
    const record = parseSlotLeaseRecord(leaseText, '2' as SlotName);
    expect(record.hashId).toBe(
      hashIdOf(descriptor.gate.kind === 'passphrase' ? descriptor.gate.argon2idHash : '')
    );

    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    expect(slots.slots).toEqual([
      {
        host: 'k7m-vale-bright.demo-domain.example.test',
        slot: '2',
        gate: {
          kind: 'passphrase',
          argon2idHash: (descriptor.gate as { argon2idHash: string }).argon2idHash,
        },
      },
    ]);
  });

  // --- "harness"-shaped proof: reconcile, replay the identical request, reset. ---
  it('harness: an identical (slot, descriptor) retry is idempotent -- no second side effect', async () => {
    broker = await startTestBroker();
    const descriptor = demoDescriptor();

    const first = await broker.signedFetch('POST', '/reconcile', { slot: '1', descriptor });
    expect(first.status).toBe(200);
    expect(broker.renderer.calls).toHaveLength(1);

    const second = await broker.signedFetch('POST', '/reconcile', { slot: '1', descriptor });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ slot: '1', phase: 'running', colour: 'a' });
    // No second render, no second wrapper start, no second lease mint --
    // LLD-2 §04: "Reconcile is idempotent on (slot, descriptorHash)."
    expect(broker.renderer.calls).toHaveLength(1);

    const reset = await broker.signedFetch('POST', '/reset', { slot: '1' });
    expect(reset.status).toBe(200);
  });

  it('a different descriptor for an already-occupied slot is refused with 409, not applied', async () => {
    broker = await startTestBroker();
    const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
    const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });

    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });
    const conflict = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: second,
    });
    expect(conflict.status).toBe(409);
    // Only the first descriptor's render ran.
    expect(broker.renderer.calls).toHaveLength(1);
    expect(broker.renderer.calls[0]?.ownerEmail).toBe('first@example.com');
  });

  it("reset actually removes the slot's lease record and slots-file entry -- the recycle contract, not just the phase", async () => {
    broker = await startTestBroker();
    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });

    await broker.signedFetch('POST', '/reset', { slot: '0' });

    await expect(readFile(`${broker.leaseDir}/0.json`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    expect(slots.slots).toEqual([]);
  });

  it('a reconcile failure resets and retries once, then reports 503 and phase "error" if the retry also fails', async () => {
    broker = await startTestBroker();
    broker.renderer.fail = true;

    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '4',
      descriptor: demoDescriptor(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ slot: '4', phase: 'error' });

    // Exactly two render attempts: the first failing try, then the retry
    // after a full reset -- never a second retry (LLD-2 §04: "retry once").
    expect(broker.renderer.calls).toHaveLength(2);

    const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // The reset the retry path takes between the two render attempts.
    expect(invocations).toEqual([['4', 'reset']]);
  });

  it('a reconcile that fails once then succeeds on the automatic retry ends running, not error', async () => {
    broker = await startTestBroker();
    let calls = 0;
    const originalRender = broker.renderer.render.bind(broker.renderer);
    broker.renderer.render = async (descriptor) => {
      calls++;
      if (calls === 1) throw new Error('first attempt fails');
      return originalRender(descriptor);
    };

    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '5',
      descriptor: demoDescriptor(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: '5', phase: 'running', colour: 'a' });
  });

  it('an unknown slot literal is refused with 422 before any side effect', async () => {
    broker = await startTestBroker();
    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '7',
      descriptor: demoDescriptor(),
    });
    expect(res.status).toBe(422);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it("a malformed descriptor is refused with 400 by render-core's own validate()", async () => {
    broker = await startTestBroker();
    const bad = { ...demoDescriptor(), slug: 'NOT VALID slug!' };
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: bad });
    expect(res.status).toBe(400);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('a paying-tenant descriptor is refused -- the broker reconciles demos only -- using a descriptor that is otherwise genuinely valid', async () => {
    broker = await startTestBroker();
    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: tenantDescriptorFixture(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'the broker reconciles demo descriptors only' });
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('a request body over the size cap is refused with 413 before any parsing', async () => {
    broker = await startTestBroker();
    const oversized = Buffer.alloc(300 * 1024, 'x');
    const headers = signHeaders(
      broker.keyPair,
      'POST',
      '/reconcile',
      oversized,
      Math.floor(broker.nowMs() / 1000)
    );
    const res = await fetch(`${broker.baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('a body that is not valid JSON is refused with 400 on /reconcile', async () => {
    broker = await startTestBroker();
    const body = Buffer.from('{not json');
    const headers = signHeaders(
      broker.keyPair,
      'POST',
      '/reconcile',
      body,
      Math.floor(broker.nowMs() / 1000)
    );
    const res = await fetch(`${broker.baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
  });

  it('a body that is not valid JSON is refused with 400 on /reset', async () => {
    broker = await startTestBroker();
    const body = Buffer.from('{not json');
    const headers = signHeaders(
      broker.keyPair,
      'POST',
      '/reset',
      body,
      Math.floor(broker.nowMs() / 1000)
    );
    const res = await fetch(`${broker.baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('an unknown slot literal on /reset is refused with 422, never reaching the wrapper', async () => {
    broker = await startTestBroker();
    const res = await broker.signedFetch('POST', '/reset', { slot: '99' });
    expect(res.status).toBe(422);
  });

  it('/reset reports 503 and phase "error" when the wrapper itself fails', async () => {
    broker = await startTestBroker();
    process.env.FAKE_WRAPPER_FAIL = '1';
    try {
      const res = await broker.signedFetch('POST', '/reset', { slot: '0' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ slot: '0', phase: 'error' });
    } finally {
      delete process.env.FAKE_WRAPPER_FAIL;
    }
    const status = await fetch(`${broker.baseUrl}/status/0`);
    expect(await status.json()).toEqual({ slot: '0', phase: 'error', healthy: false });
  });

  // --- Auth (load-bearing, LLD-2 §03): every request verified before any side effect. ---
  it('refuses /reconcile with no signature headers at all', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: '0', descriptor: demoDescriptor() }),
    });
    expect(res.status).toBe(401);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('refuses /reconcile signed by the wrong key', async () => {
    broker = await startTestBroker();
    const wrongKey = generateTestKeyPair();
    const body = Buffer.from(JSON.stringify({ slot: '0', descriptor: demoDescriptor() }));
    const headers = signHeaders(
      wrongKey,
      'POST',
      '/reconcile',
      body,
      Math.floor(broker.nowMs() / 1000)
    );
    const res = await fetch(`${broker.baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('refuses a replayed /reset request (same signature, same nonce, sent twice)', async () => {
    broker = await startTestBroker();
    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });

    const body = Buffer.from(JSON.stringify({ slot: '0' }));
    const headers = signHeaders(
      broker.keyPair,
      'POST',
      '/reset',
      body,
      Math.floor(broker.nowMs() / 1000)
    );
    const first = await fetch(`${broker.baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    const second = await fetch(`${broker.baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('/status/<slot> needs no signature at all (deliberately unauthenticated, LLD-2 §03)', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/status/0`);
    expect(res.status).toBe(200);
  });

  it('/status/<slot> refuses a slot literal outside the enumerated set with 404, never a descriptor leak', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/status/99`);
    expect(res.status).toBe(404);
  });

  it('/status rejects a path that tries to traverse out of the route entirely (falls through to the generic 404)', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/status/../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it('the router itself answers 500 rather than crashing on a malformed URL it cannot even decode', async () => {
    broker = await startTestBroker();
    // %zz is not a valid percent-escape; decodeURIComponent throws
    // URIError, which happens inside the top-level router, not inside
    // handleStatus's own try/catch -- proving the outer catch-all in
    // createBrokerHandler, not handleStatus's slot-literal refusal.
    const res = await fetch(`${broker.baseUrl}/status/%zz`);
    expect(res.status).toBe(500);
  });

  // --- "reaper"-shaped proof: /drain long-polls, answers once data arrives, and never initiates. ---
  it('reaper: /drain holds the request open and resolves once the source has something', async () => {
    broker = await startTestBroker();
    const promise = broker.signedFetch('GET', '/drain');
    // Give the handler a tick to actually start the long-poll before the
    // source resolves -- proves this is a real hold, not a value returned
    // synchronously before the poll ever began.
    await new Promise((resolve) => setTimeout(resolve, 20));
    broker.drainSource.resolveNextWith({
      mail: [{ id: 'm1', slot: '0' as SlotName, envelope: 'demo@x' }],
      mediaHashes: [],
    });
    const res = await promise;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mail: [{ id: 'm1', slot: '0', envelope: 'demo@x' }],
      mediaHashes: [],
    });
  });

  it('/drain answers with an empty payload at its own deadline rather than hanging forever', async () => {
    broker = await startTestBroker();
    const start = Date.now();
    const res = await broker.signedFetch('GET', '/drain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mail: [], mediaHashes: [] });
    // The test broker's drainPollTimeoutMs is 300ms -- this proves the
    // endpoint answered near that deadline, not that it merely returned
    // quickly by accident.
    expect(Date.now() - start).toBeGreaterThanOrEqual(280);
  });

  it('/drain answers 502 when the drain source genuinely fails (not merely times out)', async () => {
    broker = await startTestBroker();
    const promise = broker.signedFetch('GET', '/drain');
    await new Promise((resolve) => setTimeout(resolve, 20));
    broker.drainSource.rejectNextWith(new Error('spool unreachable'));
    const res = await promise;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'drain source unavailable' });
  });

  it('/drain refuses an unsigned request -- it is treated as authenticated like reconcile/reset', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/drain`);
    expect(res.status).toBe(401);
  });

  it('an unknown route is a 404', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
