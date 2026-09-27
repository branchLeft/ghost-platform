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

  // --- A new descriptor for an already-running slot moves the tenancy to
  // the other colour instead of refusing it (LLD-4 §U3b). The behaviour
  // this superseded -- a bare 409 for any change to a running slot -- is
  // now reserved for the phases that genuinely have no colour to deploy
  // alongside (`preparing`, `resetting`, `detaching`, `error`); see the
  // "a slot mid-transition" test below. ---
  describe('the colour swap', () => {
    it('deploying into the first-listed colour ("a") clears its flag -- the one flag change that moves everything', async () => {
      broker = await startTestBroker();
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });

      // Colour "a" first (the fresh-deploy path), then "b" (a swap), then
      // back onto "a" -- the direction this sub-test is about, and proof
      // the swap really does work in both orders (this story's own Done means).
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });

      const third = demoDescriptor({ ownerEmail: 'third@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: third });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slot: '0', phase: 'running', colour: 'a' });

      // Three renders/starts total: "a", then "b", then "a" again -- never
      // a `wrapper.reset` anywhere in this sequence (F1's own regression
      // shape: a swap that quietly fell back to the fresh-deploy retry
      // path would reset and wipe the colour still serving readers).
      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations).toEqual([
        ['0', 'a', 'start'],
        ['0', 'b', 'start'],
        ['0', 'a', 'start'],
      ]);
      expect(invocations.some((inv: string[]) => inv[1] === 'reset')).toBe(false);
    });

    it('deploying into the second-listed colour ("b") clears its flag, then drains "a" -- two flag changes, only the second moves traffic', async () => {
      broker = await startTestBroker();
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });

      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slot: '0', phase: 'running', colour: 'b' });

      // The verify-directly step (LLD-4 §U3b) ran against "b"'s own app
      // port before traffic moved, and the drain-refusal check ran a
      // second, independent time immediately before "a" was drained.
      expect(broker.ghostReadiness.calls.filter((p) => p === 9301)).toHaveLength(2);

      const statusRes = await fetch(`${broker.baseUrl}/status/0`);
      expect(await statusRes.json()).toMatchObject({ slot: '0', phase: 'running' });
    });

    it('refuses to drain the live colour while the new colour is not answering 200 -- the Done-means control', async () => {
      broker = await startTestBroker();
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });

      // Slot "0" colour "b" is port 9301 (slotPorts.ts: appPortBase 9300 +
      // 0*2 + 1). Healthy for the *first* call -- the bring-up readiness
      // poll inside the swap, which must succeed so the flag actually
      // clears and this scenario reaches the drain step at all -- then
      // unhealthy from the second call on: the swap's own, independent
      // re-check immediately before draining "a" (see the swap's own
      // comment on why that second check exists rather than reusing the
      // first's result).
      broker.ghostReadiness.setReadySequence(9301, [true, false]);

      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ slot: '0', phase: 'running', colour: 'a' });

      // "a" was never drained: the whole point of the refusal. This is
      // also the sabotage case for the guard itself -- deleting the
      // `if (!stillReady) { ... return ...}` block in `attemptColourSwap`
      // makes this exact assertion fail red (the flag file starts
      // existing); see the PR body for that sabotage run, verbatim.
      await expect(readFile(`${broker.drainFlagDir}/0-a.drain`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('a failed swap leaves the slot exactly as it found it -- the old colour is never reset', async () => {
      broker = await startTestBroker();
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });

      broker.renderer.fail = true;
      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ slot: '0', phase: 'running', colour: 'a' });

      // No `reset` invocation at all -- unlike the fresh-deploy retry path
      // (see "a reconcile failure resets and retries once" below), a swap
      // failure must never touch the colour still serving readers.
      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations.some((inv: string[]) => inv.includes('reset'))).toBe(false);

      const statusRes = await fetch(`${broker.baseUrl}/status/0`);
      expect(await statusRes.json()).toMatchObject({ slot: '0', phase: 'running' });
    });

    // --- A crash mid-swap is
    // invisible to recoverCrashedSlots unless an in-flight marker is
    // written before the swap's first side effect -- the same reason
    // `preparing` exists for a fresh deploy. Deterministic, not
    // timing-dependent: the renderer is the swap's own first real side
    // effect after the marker write, so having it peek at the persisted
    // state the instant it's called observes exactly what a process that
    // died right there would have left behind, with no race. ---
    it('writes the "swapping" marker (source + target colour, the new hash) before any side effect', async () => {
      broker = await startTestBroker();
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });

      let observedDuringSwap: unknown;
      const originalRender = broker.renderer.render.bind(broker.renderer);
      broker.renderer.render = async (descriptor) => {
        const { readSlotState } = await import('../../src/stateStore.js');
        observedDuringSwap = await readSlotState(broker!.stateDir, '0' as SlotName);
        return originalRender(descriptor);
      };

      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
      expect(res.status).toBe(200); // the swap itself still completes normally

      // This is the assertion the sabotage below turns red: with the
      // marker write removed, `observedDuringSwap` would still read
      // `{ phase: 'running', colour: 'a', ... }` -- indistinguishable from
      // a slot that was never touched at all, which is the exact gap a
      // crash right here would leave for a retried /reconcile to walk
      // into (see the PR body's sabotage record for this test).
      expect(observedDuringSwap).toMatchObject({
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
      });
      expect((observedDuringSwap as { swapDescriptorHash?: string }).swapDescriptorHash).toEqual(
        expect.any(String)
      );
    });

    // services/demo-gate's verify() admits a cookie only while the slots
    // file still maps the request's host to the cookie's slot and the
    // slot's lease record still names the lease the cookie was issued
    // against. This is that predicate, read from the files the gate reads.
    async function gateAdmits(b: TestBroker, host: string, cookieLease: string): Promise<boolean> {
      let slots: { slots: { host: string; slot: string }[] };
      let recordText: string;
      try {
        slots = JSON.parse(await readFile(b.slotsPath, 'utf8'));
        recordText = await readFile(`${b.leaseDir}/0.json`, 'utf8');
      } catch {
        return false;
      }
      const entry = slots.slots.find((e) => e.host === host);
      if (entry?.slot !== '0') return false;
      return parseSlotLeaseRecord(recordText, '0' as SlotName).lease === cookieLease;
    }

    it("a gated reader's cookie still admits after swaps in both directions -- a same-tenancy swap never rotates the lease", async () => {
      broker = await startTestBroker();
      const host = 'k7m-vale-bright.demo-domain.example.test';
      await broker.signedFetch('POST', '/reconcile', {
        slot: '0',
        descriptor: demoDescriptor({ ownerEmail: 'v1@example.com' as EmailAddress }),
      });
      const cookieLease = parseSlotLeaseRecord(
        await readFile(`${broker.leaseDir}/0.json`, 'utf8'),
        '0' as SlotName
      ).lease;
      expect(await gateAdmits(broker, host, cookieLease)).toBe(true);

      for (const [n, colour] of [
        [2, 'b'],
        [3, 'a'],
      ] as const) {
        broker.setNowMs(broker.nowMs() + 60_000);
        const res = await broker.signedFetch('POST', '/reconcile', {
          slot: '0',
          descriptor: demoDescriptor({ ownerEmail: `v${n}@example.com` as EmailAddress }),
        });
        expect(await res.json()).toEqual({ slot: '0', phase: 'running', colour });
        expect(await gateAdmits(broker, host, cookieLease)).toBe(true);
      }
    });

    it('a swap that changes the passphrase hash rotates the lease, tied to the new hash', async () => {
      broker = await startTestBroker();
      const host = 'k7m-vale-bright.demo-domain.example.test';
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
      const before = parseSlotLeaseRecord(
        await readFile(`${broker.leaseDir}/0.json`, 'utf8'),
        '0' as SlotName
      );

      broker.setNowMs(broker.nowMs() + 60_000);
      const newHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdDI$b3RoZXI';
      const res = await broker.signedFetch('POST', '/reconcile', {
        slot: '0',
        descriptor: demoDescriptor({ gate: { kind: 'passphrase', argon2idHash: newHash } }),
      });
      expect(res.status).toBe(200);

      const after = parseSlotLeaseRecord(
        await readFile(`${broker.leaseDir}/0.json`, 'utf8'),
        '0' as SlotName
      );
      expect(after.lease).not.toBe(before.lease);
      expect(after.hashId).toBe(hashIdOf(newHash));
      expect(await gateAdmits(broker, host, before.lease)).toBe(false);
    });

    it("refuses with 409 a descriptor for a different host on a running slot -- a swap would carry the running tenancy's database into it", async () => {
      broker = await startTestBroker();
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
      const stateBefore = await readFile(`${broker.stateDir}/0.json`, 'utf8');

      const other = demoDescriptor({
        siteUrl: 'https://p2q-other-host.demo-domain.example.test' as never,
        hostname: { kind: 'ours', sub: 'p2q-other-host', gated: true },
        gate: {
          kind: 'passphrase',
          argon2idHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdDM$dmlzaXRvcjI',
        },
      });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: other });
      expect(res.status).toBe(409);

      expect(broker.renderer.calls).toHaveLength(1);
      expect(await readFile(`${broker.stateDir}/0.json`, 'utf8')).toBe(stateBefore);
      // 'b' was never drained for a swap that was never allowed to start.
      await expect(readFile(`${broker.drainFlagDir}/0-b.drain`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('stopping the old colour', () => {
    /** Reconciles "a", then swaps into "b" -- the old colour left running, drained, is "a". */
    async function swappedToB(): Promise<void> {
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      await broker!.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });
      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker!.signedFetch('POST', '/reconcile', {
        slot: '0',
        descriptor: second,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ colour: 'b' });
    }

    it('refuses with 409 when the slot has no old colour to stop -- a fresh deploy, never swapped', async () => {
      broker = await startTestBroker();
      const descriptor = demoDescriptor();
      await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor });

      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('no old colour to stop'),
      });
    });

    it("refuses while the live colour's real-traffic counter has not advanced past the swap's own baseline -- the falsification clause", async () => {
      broker = await startTestBroker();
      await swappedToB();
      // The default: `realTraffic` reads 0 for every slot until told
      // otherwise, exactly the baseline `attemptColourSwap` itself
      // recorded (the swap ran before any traffic existed in this test).
      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        colour: 'b',
        error: expect.stringContaining('served no real traffic'),
      });
      // Refused before touching the wrapper at all -- "b" (the survivor)
      // must never be stopped, and "a" must not be stopped either.
      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations.some((inv: string[]) => inv[2] === 'stop')).toBe(false);
    });

    it('permits the stop once the counter has advanced past the baseline, and stops exactly the old colour', async () => {
      broker = await startTestBroker();
      await swappedToB();
      broker.realTraffic.setCount('0' as SlotName, 1);

      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slot: '0', phase: 'running', colour: 'b' });

      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      // "a" stopped -- never "b", the colour still serving readers.
      expect(invocations.at(-1)).toEqual(['0', 'a', 'stop']);
      expect(
        invocations.some((inv: string[]) => inv[0] === '0' && inv[1] === 'b' && inv[2] === 'stop')
      ).toBe(false);
    });

    it('refuses while an email or batch is still "submitting" -- LLD-4 §U5, even with real traffic already served', async () => {
      broker = await startTestBroker();
      await swappedToB();
      broker.realTraffic.setCount('0' as SlotName, 5);
      broker.emailBatchChecker.setSubmitting('0' as SlotName, true);

      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('submitting') });
      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations.some((inv: string[]) => inv[2] === 'stop')).toBe(false);
    });

    it('permits the stop once the submitting batch has cleared', async () => {
      broker = await startTestBroker();
      await swappedToB();
      broker.realTraffic.setCount('0' as SlotName, 5);
      broker.emailBatchChecker.setSubmitting('0' as SlotName, false);

      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(200);
    });

    it('refuses to stop the old colour when the survivor is not confirmed live right now -- never leave the slot with no colour serving', async () => {
      broker = await startTestBroker();
      await swappedToB();
      broker.realTraffic.setCount('0' as SlotName, 1);
      // "b" is the survivor at port 9301 -- unhealthy right now, despite
      // having served the traffic that advanced the counter above (a
      // regression in the narrow window after that, not impossible).
      broker.ghostReadiness.setReady(9301, false);

      const res = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('not confirmed live'),
      });
      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations.some((inv: string[]) => inv[2] === 'stop')).toBe(false);
    });

    it('is idempotent: a second /stop after a successful one returns 200 without re-running either check or stopping again', async () => {
      broker = await startTestBroker();
      await swappedToB();
      broker.realTraffic.setCount('0' as SlotName, 1);

      const first = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(first.status).toBe(200);

      // Both checks now set to refuse -- if the second call re-ran either,
      // it would get a 503 instead of the idempotent 200 below.
      broker.realTraffic.setCount('0' as SlotName, 0);
      broker.emailBatchChecker.setSubmitting('0' as SlotName, true);

      const second = await broker.signedFetch('POST', '/stop', { slot: '0' });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ slot: '0', phase: 'running', colour: 'b' });

      const invocations = (await readFile(broker.wrapperLogPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(invocations.filter((inv: string[]) => inv[2] === 'stop')).toHaveLength(1);
    });

    it('refuses with 409 on a slot that is not "running" at all -- still "free", never reconciled', async () => {
      broker = await startTestBroker();
      const res = await broker.signedFetch('POST', '/stop', { slot: '1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('not in a running state'),
      });
    });

    it('an unknown slot literal on /stop is refused with 422, never reaching the lock or either check', async () => {
      broker = await startTestBroker();
      const res = await broker.signedFetch('POST', '/stop', { slot: '9' });
      expect(res.status).toBe(422);
    });
  });

  it('a slot mid-transition (not "free", no colour recorded) is still refused with 409', async () => {
    broker = await startTestBroker();
    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
    // Simulate exactly what `recoverCrashedSlots` leaves behind: `error`,
    // no `colour` -- a phase this handler has never had a swap path for.
    const { writeSlotState } = await import('../../src/stateStore.js');
    await writeSlotState(broker.stateDir, '0' as SlotName, { phase: 'error' });

    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress }),
    });
    expect(res.status).toBe(409);
    expect(broker.renderer.calls).toHaveLength(1); // only the first, successful deploy
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
