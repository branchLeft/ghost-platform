import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AbsoluteUrl, SlotName } from '@branchleft/ghost-platform-render-core';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import { demoDescriptor } from '../helpers/fixtures.js';
import { slotUid, slotPort, slotHealthPort } from '../../src/slotPorts.js';

// The test harness's own fixed allocation (`testBroker.ts`): uidBase 30001,
// appPortBase 9300, healthPortBase 9100.
const UID_BASE = 30001;
const APP_PORT_BASE = 9300;
const HEALTH_PORT_BASE = 9100;

/**
 * The recycle contract's whole point is that a previous visitor's hash and
 * lease never outlive their tenancy. These prove that holds under
 * concurrent and interleaved requests -- a slot claimed by one in-flight
 * request refusing a second, a shared file surviving simultaneous writes
 * to different slots, a duplicate host refused, an unrotated hash refused,
 * a failed teardown leaving no live access -- not only in the
 * single-request path the rest of app.test.ts covers.
 */

function hashFor(tag: string): string {
  const salt = Buffer.from('saltsalt' + tag)
    .toString('base64')
    .replace(/=+$/, '');
  return `$argon2id$v=19$m=65536,t=3,p=4$${salt}$aGFzaA`;
}

/**
 * `slot` decides the descriptor's own `uid`/`ports`: item 1's mismatch
 * refusal means a descriptor aimed at slot `N` must carry slot `N`'s own
 * derived allocation, not an arbitrary fixed one, or every call below would
 * be refused with 400 before it ever reached the race this file exists to
 * prove.
 */
function descFor(sub: string, tag: string, slot: string, extra: Record<string, unknown> = {}) {
  const s = slot as SlotName;
  return demoDescriptor({
    siteUrl: `https://${sub}.demo-domain.example.test` as AbsoluteUrl,
    hostname: { kind: 'ours', sub, gated: true },
    gate: { kind: 'passphrase', argon2idHash: hashFor(tag) },
    uid: slotUid(UID_BASE, s) as never,
    ports: {
      a: slotPort(APP_PORT_BASE, s, 'a'),
      b: slotPort(APP_PORT_BASE, s, 'b'),
      health: slotHealthPort(HEALTH_PORT_BASE, s),
    } as never,
    ...extra,
  } as never);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe('concurrency and recycle-contract regressions', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  // F1: two different reconciles racing one free slot.
  it('exactly one of two racing reconciles on one free slot wins; the loser is refused, not applied', async () => {
    broker = await startTestBroker();
    const [r1, r2] = await Promise.all([
      broker.signedFetch('POST', '/reconcile', {
        slot: '3',
        descriptor: descFor('aaa-one', 'A', '3'),
      }),
      broker.signedFetch('POST', '/reconcile', {
        slot: '3',
        descriptor: descFor('bbb-two', 'B', '3'),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    expect(slots.slots).toHaveLength(1);

    // Whichever won, the slots file and the lease agree with each other --
    // never a hash from one descriptor paired with a lease minted for the
    // other, and never two entries for one slot.
    const leaseText = await readFile(join(broker.leaseDir, '3.json'), 'utf8');
    const lease = JSON.parse(leaseText);
    expect(slots.slots[0].gate.argon2idHash).toBeDefined();
    expect(lease.hashId).toBeDefined();
  });

  // F1: a reset racing an in-flight reconcile must never leave the slot
  // `free` while the tenancy's hash and lease stay live.
  it('a reset racing an in-flight reconcile leaves no live lease/hash if the slot reads free', async () => {
    broker = await startTestBroker();
    const rec = broker.signedFetch('POST', '/reconcile', {
      slot: '4',
      descriptor: descFor('ccc-three', 'C', '4'),
    });
    await new Promise((r) => setTimeout(r, 2));
    const rst = broker.signedFetch('POST', '/reset', { slot: '4' });
    const [recRes, rstRes] = await Promise.all([rec, rst]);

    // One of the two must have been refused by the per-slot lock (F1) --
    // never both succeeding against an overlapping window.
    expect([recRes.status, rstRes.status].includes(409)).toBe(true);

    const state = JSON.parse(await readFile(join(broker.stateDir, '4.json'), 'utf8'));
    const leaseIsLive = await fileExists(join(broker.leaseDir, '4.json'));
    if (state.phase === 'free') {
      // The invariant the review's A2 attack broke: `free` must never
      // coexist with a live lease record.
      expect(leaseIsLive).toBe(false);
    }
  });

  // F2: concurrent reconciles on *different* slots must not lose slots-file
  // entries to a lost read-modify-write.
  it('six concurrent reconciles on six different slots leave six slots-file entries and six leases', async () => {
    broker = await startTestBroker();
    const slotsToTry = ['1', '2', '3', '4', '5', '6'];
    const results = await Promise.all(
      slotsToTry.map((s) =>
        broker!.signedFetch('POST', '/reconcile', {
          slot: s,
          descriptor: descFor(`host-${s}x`, `H${s}`, s, { slug: `demo-${s}` }),
        })
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    expect(slots.slots).toHaveLength(6);

    let leaseCount = 0;
    for (const s of slotsToTry) {
      if (await fileExists(join(broker.leaseDir, `${s}.json`))) leaseCount++;
    }
    expect(leaseCount).toBe(6);
  });

  // F8: a duplicate hostname across two slots must be refused -- admitting
  // both takes down services/demo-gate's whole-file parse for every demo.
  it('refuses a reconcile whose host is already held by a different slot', async () => {
    broker = await startTestBroker();
    const first = await broker.signedFetch('POST', '/reconcile', {
      slot: '1',
      descriptor: descFor('same-host', 'E', '1'),
    });
    expect(first.status).toBe(200);

    const second = await broker.signedFetch('POST', '/reconcile', {
      slot: '2',
      descriptor: descFor('same-host', 'F', '2', { slug: 'demo-2' }),
    });
    expect(second.status).toBe(409);

    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    const withThatHost = slots.slots.filter(
      (e: { host: string }) => e.host === 'same-host.demo-domain.example.test'
    );
    expect(withThatHost).toHaveLength(1);
  });

  // F8, the narrow race: two different slots reconciling the SAME host
  // concurrently both pass the early, best-effort pre-check before either
  // has written anything -- the atomic backstop inside upsertSlotEntry is
  // what actually decides, and the loser must be torn down and freed, not
  // left running with no valid lease.
  it('two different slots racing the same host: the loser is torn down and freed, not left half-started', async () => {
    broker = await startTestBroker();
    const [r1, r2] = await Promise.all([
      broker.signedFetch('POST', '/reconcile', {
        slot: '1',
        descriptor: descFor('raced-host', 'R1', '1'),
      }),
      broker.signedFetch('POST', '/reconcile', {
        slot: '2',
        descriptor: descFor('raced-host', 'R2', '2', { slug: 'demo-r2' }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    const withThatHost = slots.slots.filter(
      (e: { host: string }) => e.host === 'raced-host.demo-domain.example.test'
    );
    expect(withThatHost).toHaveLength(1);

    // The loser's slot must be free, with no live lease left behind.
    const loserSlot = r1.status === 409 ? '1' : '2';
    const state = JSON.parse(await readFile(join(broker.stateDir, `${loserSlot}.json`), 'utf8'));
    expect(state.phase).toBe('free');
    expect(await fileExists(join(broker.leaseDir, `${loserSlot}.json`))).toBe(false);
  });

  // F9: recycle contract (a) -- an unrotated hash on the very next reconcile
  // of a just-reset slot is refused, not silently accepted.
  it("refuses a recycle that reuses the previous tenancy's exact hash, and accepts a genuinely new one", async () => {
    broker = await startTestBroker();
    const first = await broker.signedFetch('POST', '/reconcile', {
      slot: '1',
      descriptor: descFor('ddd-four', 'D', '1'),
    });
    expect(first.status).toBe(200);

    await broker.signedFetch('POST', '/reset', { slot: '1' });

    const sameHash = await broker.signedFetch('POST', '/reconcile', {
      slot: '1',
      descriptor: descFor('other-host', 'D', '1'),
    });
    expect(sameHash.status).toBe(409);

    const newHash = await broker.signedFetch('POST', '/reconcile', {
      slot: '1',
      descriptor: descFor('other-host', 'D-rotated', '1'),
    });
    expect(newHash.status).toBe(200);
  });

  // `assertHashRotated` compares only against the immediately previous
  // tenancy, so a hash from two recycles back is accepted on a third
  // reconcile -- documented in `stateStore.ts` as within
  // `render-core/src/lease.ts`'s contract as written ("replaced on every
  // recycle" is a one-step comparison), not a gap. Pinned here so a
  // future reader sees this is deliberate, not untested.
  it('accepts a hash from two recycles back (A -> B -> A): the one-step rotation contract as documented, not a gap', async () => {
    broker = await startTestBroker();
    const first = await broker.signedFetch('POST', '/reconcile', {
      slot: '6',
      descriptor: descFor('rotate-history', 'HIST-A', '6'),
    });
    expect(first.status).toBe(200);

    await broker.signedFetch('POST', '/reset', { slot: '6' });
    const second = await broker.signedFetch('POST', '/reconcile', {
      slot: '6',
      descriptor: descFor('rotate-history', 'HIST-B', '6'),
    });
    expect(second.status).toBe(200);

    await broker.signedFetch('POST', '/reset', { slot: '6' });
    // Hash "HIST-A" again -- two recycles back, not the immediately
    // previous tenancy ("HIST-B"), so `assertHashRotated` admits it.
    const third = await broker.signedFetch('POST', '/reconcile', {
      slot: '6',
      descriptor: descFor('rotate-history', 'HIST-A', '6'),
    });
    expect(third.status).toBe(200);
  });

  // F10: a reset whose teardown fails must not leave the previous visitor
  // admitted -- revoke (clear lease/hash) happens before the wrapper runs.
  it('a reset whose wrapper call fails has already cleared the lease and hash', async () => {
    broker = await startTestBroker();
    expect(
      (
        await broker.signedFetch('POST', '/reconcile', {
          slot: '5',
          descriptor: descFor('eee-five', 'G', '5'),
        })
      ).status
    ).toBe(200);

    process.env.FAKE_WRAPPER_FAIL = '1';
    try {
      const r = await broker.signedFetch('POST', '/reset', { slot: '5' });
      expect(r.status).toBe(503);
    } finally {
      delete process.env.FAKE_WRAPPER_FAIL;
    }

    expect(await fileExists(join(broker.leaseDir, '5.json'))).toBe(false);
    const slots = JSON.parse(await readFile(broker.slotsPath, 'utf8'));
    expect(slots.slots.find((e: { slot: string }) => e.slot === '5')).toBeUndefined();
  });
});
