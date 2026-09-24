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
import { demoDescriptor, descriptorForSlot, tenantDescriptorFixture } from '../helpers/fixtures.js';
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
    const descriptor = descriptorForSlot('2' as SlotName, { slug: 'demo-recycle' as Slug });

    const res = await broker.signedFetch('POST', '/reconcile', { slot: '2', descriptor });
    expect(res.status).toBe(200);

    expect(broker.renderer.calls).toHaveLength(1);
    expect(broker.adminApi.calls).toHaveLength(1);
    // The slot's own fixed port (F7): appPortBase=9300, slot '2', colour 'a'
    // -> 9300 + 2*2 = 9304. A literal, not `descriptor.ports.a`: since item
    // 1's refusal (above) refuses any descriptor whose ports disagree
    // with the slot's own allocation before this handler runs, the two are
    // equal by construction for every accepted request here on -- asserting
    // against `descriptor.ports.a` would merely echo back whatever the
    // request sent, true or not. This literal is the actual independent
    // check; `slotPorts.test.ts` separately proves the formula itself.
    expect(broker.adminApi.calls[0]?.baseUrl).toBe('http://127.0.0.1:9304');

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
    const descriptor = descriptorForSlot('1' as SlotName);

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
      descriptor: descriptorForSlot('4' as SlotName),
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
      descriptor: descriptorForSlot('5' as SlotName),
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

  // --- Item 1: a descriptor whose ports or uid disagree with the slot's
  // own allocation is refused before the renderer or the Admin API ever
  // see it. ---
  it("refuses a descriptor whose ports don't match the slot's own derived allocation", async () => {
    broker = await startTestBroker();
    // slot "0"'s own port `a` is 9300 (see fixtures.ts); 4101 is a
    // different slot's port entirely -- exactly F7's attack shape.
    const bad = demoDescriptor({
      ports: { a: 4101 as never, b: 9301 as never, health: 9100 as never },
    });
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "descriptor's uid/ports don't match slot \"0\"'s own allocation",
    });
    expect(broker.renderer.calls).toHaveLength(0);
    expect(broker.adminApi.calls).toHaveLength(0);
  });

  it("refuses a descriptor whose uid doesn't match the slot's own derived uid", async () => {
    broker = await startTestBroker();
    // slot "0"'s own uid is 30001 (see fixtures.ts); 30123 belongs to a
    // different slot's reserved range.
    const bad = demoDescriptor({ uid: 30123 as never });
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: bad });
    expect(res.status).toBe(400);
    expect(broker.renderer.calls).toHaveLength(0);
    expect(broker.adminApi.calls).toHaveLength(0);
  });

  // F1 (review, cycle 1): `ports.a` and `uid` were the only two of the four
  // comparisons with a test, so deleting the `ports.b` or `ports.health`
  // clause from app.ts stayed green. `descriptorForSlot`'s default is a
  // fully correct allocation, so these override exactly one field each,
  // leaving `a` and `uid` correct -- if either clause were missing, the
  // request would be wrongly admitted.
  it("refuses a descriptor whose ports.b doesn't match the slot's own allocation, with everything else correct", async () => {
    broker = await startTestBroker();
    const good = descriptorForSlot('0' as SlotName);
    const bad = demoDescriptor({ ports: { ...good.ports, b: 4101 as never } });
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "descriptor's uid/ports don't match slot \"0\"'s own allocation",
    });
    expect(broker.renderer.calls).toHaveLength(0);
    expect(broker.adminApi.calls).toHaveLength(0);
  });

  it("refuses a descriptor whose ports.health doesn't match the slot's own allocation, with everything else correct", async () => {
    broker = await startTestBroker();
    const good = descriptorForSlot('0' as SlotName);
    const bad = demoDescriptor({ ports: { ...good.ports, health: 4101 as never } });
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "descriptor's uid/ports don't match slot \"0\"'s own allocation",
    });
    expect(broker.renderer.calls).toHaveLength(0);
    expect(broker.adminApi.calls).toHaveLength(0);
  });

  it('accepts a descriptor whose ports and uid match the target slot exactly (the positive case alongside the refusal above)', async () => {
    broker = await startTestBroker();
    const good = descriptorForSlot('3' as SlotName);
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '3', descriptor: good });
    expect(res.status).toBe(200);
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

  // --- Item 2: a request timestamped in the same wall-clock second as this
  // process's own start is refused, not only one that predates it. ---
  it('refuses a same-second replay: a request timestamped exactly at process start (capture, crash, restart, all within one second)', async () => {
    broker = await startTestBroker();
    // testBroker's own `processStartSeconds` is `floor(START_MS / 1000)`;
    // pointing `nowMs` back at exactly `START_MS` makes this signed
    // request's timestamp equal to it -- the same-second edge a capture,
    // a crash and a restart landing in one wall-clock second produce.
    broker.setNowMs(broker.processStartSeconds * 1000);
    const res = await broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(res.status).toBe(401);
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

  it('a malformed percent-escape in the status path answers 404, not 500 (review finding)', async () => {
    broker = await startTestBroker();
    // %zz is not a valid percent-escape; decodeURIComponent throws
    // URIError. The router catches it at the point of decoding and answers
    // exactly as it would for any other string that isn't one of the seven
    // slot literals, rather than letting it fall to the generic 500
    // catch-all -- a malformed request must never look like a server fault.
    const res = await fetch(`${broker.baseUrl}/status/%zz`);
    expect(res.status).toBe(404);
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
