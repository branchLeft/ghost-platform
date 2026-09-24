import { Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSourceAllowList,
  createConcurrencyGuard,
  createSmtpFrontDoor,
  createSubmitterLimiter,
  createUnauthenticatedAdmissionQueue,
  createUnauthenticatedPoolGuard,
  DEFAULT_ALLOWED_SOURCE_CIDRS,
  isAllowedSource,
  type SmtpFrontDoor,
  type UnauthenticatedAdmissionResult,
  type UnauthenticatedPoolAdmission,
  type UnauthenticatedPoolGuard,
} from '../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { WorkerHandle } from '../../src/worker.js';
import { createTestLogger, type CapturedLogLine } from '../helpers/testLogger.js';

// The real shipped default, not a hand copy — a hand copy would drift
// silently from the exported constant, and a widened default would still
// pass every test here.
const DEFAULT_CIDRS = DEFAULT_ALLOWED_SOURCE_CIDRS;

describe('buildSourceAllowList', () => {
  it('treats a bare address with no "/" prefix as a single host, not a range', () => {
    const allowList = buildSourceAllowList(['203.0.113.7']);
    expect(isAllowedSource('203.0.113.7', allowList)).toBe(true);
    expect(isAllowedSource('203.0.113.8', allowList)).toBe(false);
  });

  it('treats a bare IPv6 address with no "/" prefix as a single host, not a range', () => {
    const allowList = buildSourceAllowList(['2001:db8::1']);
    expect(isAllowedSource('2001:db8::1', allowList)).toBe(true);
    expect(isAllowedSource('2001:db8::2', allowList)).toBe(false);
  });
});

describe('buildSourceAllowList / isAllowedSource', () => {
  const allowList = buildSourceAllowList(DEFAULT_CIDRS);

  it.each<[string, string]>([
    ['127.0.0.1', 'IPv4 loopback'],
    ['::1', 'IPv6 loopback'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.20.0.5', 'RFC1918 172.16/12 (Docker bridge range)'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['fc00::1', 'ULA fc00::/7 (fc)'],
    ['fd12:3456::1', 'ULA fc00::/7 (fd)'],
    ['::ffff:10.0.0.5', 'IPv4-mapped IPv6 of a private address'],
  ])('allows %s (%s)', (address) => {
    expect(isAllowedSource(address, allowList)).toBe(true);
  });

  it.each<[string | undefined, string]>([
    ['8.8.8.8', 'public IPv4'],
    ['2001:db8::1', 'public/documentation IPv6'],
    ['::ffff:8.8.8.8', 'IPv4-mapped IPv6 of a public address'],
    [undefined, 'no remote address at all'],
    ['not-an-ip', 'garbage'],
  ])('refuses %s (%s)', (address) => {
    expect(isAllowedSource(address, allowList)).toBe(false);
  });
});

describe('createSubmitterLimiter', () => {
  it('allows up to the limit within a window, then blocks', () => {
    const limiter = createSubmitterLimiter(2, 1000, () => 0);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
  });

  it('resets once the window has elapsed', () => {
    let now = 0;
    const limiter = createSubmitterLimiter(1, 1000, () => now);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
    now = 1000;
    expect(limiter.tryTake('tenant-a')).toBe(true);
  });

  it('keys per submitter identity — one tenant exhausting its bucket never touches another', () => {
    const limiter = createSubmitterLimiter(1, 1000, () => 0);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
    expect(limiter.tryTake('tenant-b')).toBe(true);
  });
});

describe('createConcurrencyGuard', () => {
  it('grants up to the global cap, then refuses regardless of key', () => {
    const guard = createConcurrencyGuard(2, 5);
    expect(guard.tryAcquire('a')).not.toBeNull();
    expect(guard.tryAcquire('b')).not.toBeNull();
    expect(guard.tryAcquire('c')).toBeNull();
  });

  it('grants up to the per-key cap even under the global cap', () => {
    const guard = createConcurrencyGuard(10, 1);
    expect(guard.tryAcquire('a')).not.toBeNull();
    expect(guard.tryAcquire('a')).toBeNull();
    // A different key is unaffected by 'a' exhausting its own cap.
    expect(guard.tryAcquire('b')).not.toBeNull();
  });

  it('release() frees exactly one slot, both global and per-key', () => {
    const guard = createConcurrencyGuard(1, 1);
    const slot = guard.tryAcquire('a');
    expect(slot).not.toBeNull();
    expect(guard.tryAcquire('a')).toBeNull();
    slot!.release();
    expect(guard.tryAcquire('a')).not.toBeNull();
  });

  it('release() is idempotent — calling it many times only ever frees the slot once', () => {
    // The same unit of work can be released from more than one event (a
    // stream ending normally, a stream erroring, or the underlying
    // connection closing without either firing), and a double-release must
    // never double-free budget that was never actually double-acquired.
    // Per-key cap is generous (5) so only the global cap (1) is what's
    // under test here — two DIFFERENT keys isolate the global counter's
    // own correctness from the per-key bookkeeping tested elsewhere.
    const guard = createConcurrencyGuard(1, 5);
    const slot = guard.tryAcquire('a')!;
    slot.release();
    slot.release();
    slot.release();
    // A non-idempotent release() would have decremented three times
    // (global at -2 here instead of 0), which doesn't fail on the very
    // next acquire — going negative just means the guard incorrectly
    // admits MORE than its cap of 1 for a while, not fewer. The real
    // proof is that only ONE further acquisition succeeds before the cap
    // binds again, not two.
    expect(guard.tryAcquire('b')).not.toBeNull();
    expect(guard.tryAcquire('c')).toBeNull();
  });

  it('a refused (null) acquisition never affects the counts — nothing to release', () => {
    const guard = createConcurrencyGuard(1, 1);
    guard.tryAcquire('a');
    const refused = guard.tryAcquire('a');
    expect(refused).toBeNull();
    // Releasing the ONE granted slot is the only thing that frees capacity;
    // the refused attempt held nothing to begin with.
    expect(guard.tryAcquire('b')).toBeNull(); // still at the global cap of 1
  });

  it('releasing one key does not affect a different key already at its own cap', () => {
    const guard = createConcurrencyGuard(5, 1);
    const a = guard.tryAcquire('a')!;
    const b = guard.tryAcquire('b')!;
    expect(guard.tryAcquire('a')).toBeNull();
    b.release();
    // 'a' is still at its own per-key cap of 1, even though 'b' released.
    expect(guard.tryAcquire('a')).toBeNull();
    expect(guard.tryAcquire('b')).not.toBeNull();
    void a;
  });
});

describe('createUnauthenticatedPoolGuard', () => {
  // Filtering smtp-server's own `connections` Set counts a connection from
  // the instant its TCP handshake completes, not from the instant this
  // guard would have admitted it — smtp-server holds every accepted socket
  // for a fixed ~100ms "early talker" delay before its onConnect hook even
  // runs. A burst of connections from one source therefore all land in
  // that Set together, all still pending their own admission check, and a
  // filter over the Set counts every one of them as if already admitted.
  // This guard's own counters increment only on a tryAcquire that itself
  // returns admitted — never from anything outside its control — so a
  // burst can never inflate its counts beyond what it actually let
  // through, regardless of how many raw sockets are simultaneously open.
  it('admits up to the per-source cap, then refuses further acquisitions from that source with a distinct reason', () => {
    const guard = createUnauthenticatedPoolGuard(100, 2);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(true);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(true);
    const third = guard.tryAcquire('1.1.1.1');
    expect(third.admitted).toBe(false);
    expect(third).toMatchObject({ reason: 'max_unauthenticated_connections_per_source' });
  });

  it('admits a different source up to ITS OWN per-source cap even while another source sits at its own cap', () => {
    const guard = createUnauthenticatedPoolGuard(100, 2);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(true);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(true);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(false);
    // A different source is unaffected by '1.1.1.1' exhausting its own cap
    // — this is the exact property that was missing live: many burst
    // acquisitions from one source must never count against another's
    // admission.
    expect(guard.tryAcquire('2.2.2.2').admitted).toBe(true);
    expect(guard.tryAcquire('2.2.2.2').admitted).toBe(true);
  });

  it('refuses with the global reason once the global cap is reached, even from a source still under its own per-source cap', () => {
    const guard = createUnauthenticatedPoolGuard(1, 5);
    expect(guard.tryAcquire('1.1.1.1').admitted).toBe(true);
    const second = guard.tryAcquire('2.2.2.2');
    expect(second.admitted).toBe(false);
    expect(second).toMatchObject({ reason: 'max_unauthenticated_connections' });
  });

  it('release() frees exactly one slot, both global and per-source, and is idempotent', () => {
    const guard = createUnauthenticatedPoolGuard(1, 1);
    const admission = guard.tryAcquire('1.1.1.1');
    if (!admission.admitted) throw new Error('expected admission');
    expect(guard.tryAcquire('2.2.2.2').admitted).toBe(false);
    admission.slot.release();
    admission.slot.release();
    admission.slot.release();
    // A non-idempotent release would have freed three slots' worth of
    // global budget instead of one — the proof is that only ONE further
    // acquisition succeeds before the cap binds again, not two.
    expect(guard.tryAcquire('2.2.2.2').admitted).toBe(true);
    expect(guard.tryAcquire('3.3.3.3').admitted).toBe(false);
  });

  it('a burst of acquisitions past the per-source cap never lets that source exceed its own admitted cap, however many were attempted', () => {
    // Directly exercises the property the live churn attack depended on
    // breaking: hammering tryAcquire far faster than anything could ever
    // be released must still leave the source with no more than its own
    // cap's worth of admitted slots, and a different source fully able to
    // acquire its own.
    const guard = createUnauthenticatedPoolGuard(1000, 5);
    let admitted = 0;
    for (let i = 0; i < 500; i++) {
      if (guard.tryAcquire('192.168.65.1').admitted) admitted += 1;
    }
    expect(admitted).toBe(5);
    const other = guard.tryAcquire('172.23.0.4');
    expect(other.admitted).toBe(true);
  });
});

describe('createUnauthenticatedAdmissionQueue', () => {
  // A hand-controlled scheduler in place of real setTimeout/clearTimeout:
  // every test drives the passage of time explicitly by invoking a
  // captured callback itself, rather than waiting on the clock — makes
  // every branch (including ones a real timer would only hit after a real
  // wait) directly, deterministically reachable.
  function slotOf(result: UnauthenticatedAdmissionResult | undefined): { release(): void } {
    if (!result || !result.admitted) {
      throw new Error('expected an admitted result');
    }
    return result.slot;
  }

  function fakeScheduler(): {
    schedule: (fn: () => void, ms: number) => { fn: () => void; ms: number; cleared: boolean };
    cancel: (handle: unknown) => void;
    scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  } {
    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    return {
      schedule: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        scheduled.push(handle);
        return handle;
      },
      cancel: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      scheduled,
    };
  }

  it('admits immediately when the guard has room, never touching the scheduler', () => {
    const guard = createUnauthenticatedPoolGuard(10, 5);
    const { schedule, cancel, scheduled } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    const results: UnauthenticatedAdmissionResult[] = [];
    const pending = queue.request('1.1.1.1', (r) => results.push(r));

    expect(results).toEqual([{ admitted: true, slot: expect.anything() }]);
    expect(scheduled).toHaveLength(0);
    // Nothing to withdraw once a result already arrived — cancel() on an
    // already-resolved request is always safe to call unconditionally.
    expect(() => pending.cancel()).not.toThrow();
  });

  it('refuses immediately on the global cap — never queued, matching the design comment', () => {
    const guard = createUnauthenticatedPoolGuard(1, 5);
    guard.tryAcquire('someone-else'); // fill the global cap of 1
    const { schedule, cancel, scheduled } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    const results: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => results.push(r));

    expect(results).toEqual([{ admitted: false, reason: 'max_unauthenticated_connections' }]);
    expect(scheduled).toHaveLength(0);
  });

  it('queues a per-source-refused request instead of refusing it, and admits it once a same-source slot frees', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    const firstResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => firstResults.push(r));
    expect(firstResults[0]).toMatchObject({ admitted: true });
    const firstSlot = slotOf(firstResults[0]);

    // Second request from the SAME source is over its own cap (1) — queued,
    // not refused, and no result yet.
    const secondResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => secondResults.push(r));
    expect(secondResults).toHaveLength(0);

    // Releasing the first admits the second — this is the mechanism the
    // whole fix depends on: a burst waits for the ordinary trickle of
    // releases rather than being turned away.
    firstSlot.release();
    expect(secondResults).toEqual([{ admitted: true, slot: expect.anything() }]);
  });

  it('refuses outright, not queued, once the per-source wait queue is already at its bound', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 1, 1000, schedule, cancel);

    queue.request('1.1.1.1', () => {}); // admitted, fills the per-source cap of 1
    queue.request('1.1.1.1', () => {}); // queued, fills the queue depth of 1

    const thirdResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => thirdResults.push(r));

    expect(thirdResults).toEqual([
      { admitted: false, reason: 'max_unauthenticated_connections_per_source_queue_full' },
    ]);
  });

  it('refuses a queued request once its own wait bound elapses, with a distinct reason', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel, scheduled } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    queue.request('1.1.1.1', () => {}); // admitted, fills the cap
    const results: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => results.push(r)); // queued

    expect(results).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!.fn(); // drive the clock forward by hand

    expect(results).toEqual([
      { admitted: false, reason: 'max_unauthenticated_connections_per_source_wait_timeout' },
    ]);
  });

  it('cancel() withdraws a still-queued request cleanly — no result ever fires, and the scheduled timeout is cleared', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel, scheduled } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    queue.request('1.1.1.1', () => {}); // fills the cap
    const results: UnauthenticatedAdmissionResult[] = [];
    const pending = queue.request('1.1.1.1', (r) => results.push(r));

    pending.cancel();

    expect(scheduled[0]!.cleared).toBe(true);
    expect(results).toHaveLength(0);
    // The withdrawn request's own timeout firing anyway (this queue's
    // `cancelTimeout` is only a promise the real one keeps, not something
    // this code can force) must still be a no-op, not a late result.
    scheduled[0]!.fn();
    expect(results).toHaveLength(0);
  });

  it('cancel() called twice on the same request is safe — the second call finds nothing left to drop', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    queue.request('1.1.1.1', () => {}); // fills the cap
    const pending = queue.request('1.1.1.1', () => {}); // queued

    pending.cancel();
    // Nothing to assert beyond "this does not throw" — the queue for this
    // source was already emptied and deleted by the first cancel(), so the
    // second must find no queue at all and return cleanly.
    expect(() => pending.cancel()).not.toThrow();
  });

  it('a slot freeing for one source can only ever admit a waiter of that SAME source, never a different one’s', () => {
    const guard = createUnauthenticatedPoolGuard(10, 1);
    const { schedule, cancel } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(guard, 5, 1000, schedule, cancel);

    const aResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('A', (r) => aResults.push(r));
    const aSlot = slotOf(aResults[0]);
    queue.request('A', (r) => aResults.push(r)); // queued behind A's own cap

    const bResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('B', (r) => bResults.push(r));
    const bSlot = slotOf(bResults[0]);

    // Releasing B's own slot must never admit A's queued waiter.
    bSlot.release();
    expect(aResults).toHaveLength(1); // still just the first admission

    aSlot.release();
    expect(aResults).toHaveLength(2);
    expect(aResults[1]).toMatchObject({ admitted: true });
  });

  it('if the guard itself refuses the immediate re-acquire a freed slot should have won (the global cap filled in between), the waiter keeps its place instead of being dropped', () => {
    // A hand-rolled guard, not the real one: scripted to admit the first
    // call for a source and then refuse every call after, so this proves
    // the queue's own reentrancy defence — not a real race, which
    // single-threaded JS makes impossible between a release() and the
    // queue's own very next line, but a guarantee the queue does not rely
    // on that impossibility silently.
    // Call 1 (the first request's own immediate check): admits. Call 2
    // (the second request's own immediate check): refuses per-source, so
    // the queue holds it rather than refusing it outright. Call 3 (the
    // re-acquire the queue itself makes when the first slot releases):
    // refuses on the GLOBAL reason — standing in for "something else took
    // the last global slot in between" — which is the case this test
    // exists to prove the queue survives without dropping the waiter.
    let calls = 0;
    const scriptedGuard: UnauthenticatedPoolGuard = {
      tryAcquire(remoteAddress): UnauthenticatedPoolAdmission {
        calls += 1;
        void remoteAddress;
        if (calls === 1) {
          return { admitted: true, slot: { release(): void {} } };
        }
        if (calls === 2) {
          return { admitted: false, reason: 'max_unauthenticated_connections_per_source' };
        }
        return { admitted: false, reason: 'max_unauthenticated_connections' };
      },
    };

    const { schedule, cancel } = fakeScheduler();
    const queue = createUnauthenticatedAdmissionQueue(scriptedGuard, 5, 1000, schedule, cancel);

    const firstResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => firstResults.push(r));
    const firstSlot = slotOf(firstResults[0]);

    const secondResults: UnauthenticatedAdmissionResult[] = [];
    queue.request('1.1.1.1', (r) => secondResults.push(r)); // queued (calls === 1 already spent)

    firstSlot.release(); // triggers a re-acquire that the scripted guard refuses
    // The waiter is neither admitted nor refused — it keeps its queued
    // place rather than being dropped on the floor.
    expect(secondResults).toHaveLength(0);
  });
});

interface Harness {
  store: ShimStore;
  worker: WorkerHandle;
  frontDoor: SmtpFrontDoor;
  port: number;
  logs: ReturnType<typeof createTestLogger>['lines'];
  close(): Promise<void>;
}

async function startHarness(
  overrides: Partial<{
    allowedSourceCidrs: string[];
    /**
     * True omission, not "pass DEFAULT_CIDRS explicitly" — exercises
     * `createSmtpFrontDoor`'s own `opts.allowedSourceCidrs ?? DEFAULT_ALLOWED_SOURCE_CIDRS`
     * fallback in `smtpFrontDoor.ts` itself, which every other harness call
     * (always passing an explicit array) never touches.
     */
    omitAllowedSourceCidrs: boolean;
    submitterMessagesPerMinute: number;
    maxMessageBytes: number;
    maxRecipientsPerMessage: number;
    maxUnauthenticatedConnectionsPerSource: number;
    maxUnauthenticatedConnections: number;
    maxUnauthenticatedPerSourceWaitQueueDepth: number;
    maxUnauthenticatedPerSourceWaitMs: number;
    authDeadlineMs: number;
    maxConcurrentDataPhases: number;
    maxConcurrentDataPhasesPerSubmitter: number;
    host: string;
    /** A worker whose `whenIdle()` never resolves — proves the ack can't be coupled to it. */
    workerNeverIdle: boolean;
  }> = {}
): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  store.registerTenant('tenant-a.example.com', 'key-a');
  store.registerTenant('tenant-b.example.com', 'key-b');

  const kick = vi.fn();
  const worker: WorkerHandle = {
    kick,
    whenIdle: () => (overrides.workerNeverIdle ? new Promise<void>(() => {}) : Promise.resolve()),
    stop: () => Promise.resolve(),
    status: () => ({ lastTickAt: null, stopped: false }),
  };

  const { logger, lines } = createTestLogger();

  const frontDoor = createSmtpFrontDoor({
    store,
    worker,
    log: logger,
    maxMessageBytes: overrides.maxMessageBytes ?? 1024 * 1024,
    maxRecipientsPerMessage: overrides.maxRecipientsPerMessage ?? 50,
    maxUnauthenticatedConnectionsPerSource: overrides.maxUnauthenticatedConnectionsPerSource ?? 20,
    maxUnauthenticatedConnections: overrides.maxUnauthenticatedConnections ?? 20,
    maxUnauthenticatedPerSourceWaitQueueDepth:
      overrides.maxUnauthenticatedPerSourceWaitQueueDepth ?? 50,
    maxUnauthenticatedPerSourceWaitMs: overrides.maxUnauthenticatedPerSourceWaitMs ?? 2000,
    authDeadlineMs: overrides.authDeadlineMs ?? 5000,
    maxConcurrentDataPhases: overrides.maxConcurrentDataPhases ?? 20,
    maxConcurrentDataPhasesPerSubmitter: overrides.maxConcurrentDataPhasesPerSubmitter ?? 5,
    ...(overrides.omitAllowedSourceCidrs
      ? {}
      : { allowedSourceCidrs: overrides.allowedSourceCidrs ?? DEFAULT_CIDRS }),
    submitterMessagesPerMinute: overrides.submitterMessagesPerMinute ?? 120,
  });

  const port = 20000 + Math.floor(Math.random() * 20000);
  await frontDoor.listen(port, overrides.host ?? '127.0.0.1');

  return {
    store,
    worker,
    frontDoor,
    port,
    logs: lines,
    async close() {
      await frontDoor.close();
      store.close();
    },
  };
}

/**
 * A raw protocol script, bypassing nodemailer's own client-side address
 * normalisation — nodemailer's client resolves a group/list-syntax `to`
 * string to a plain address BEFORE it ever reaches the wire (the same
 * behaviour smtp.ts's own doc comment describes on the send side), so a
 * client-library-based test can never actually put the crafted string in
 * front of the server's RCPT TO handler. A raw socket can.
 */
function rawSmtpCommands(port: number, host: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const responses: string[] = [];
    let buffer = '';
    let step = 0;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\r\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '') continue;
        // Multi-line responses use "250-"; only act once the final line
        // ("250 ") of a batch arrives.
        if (/^\d{3}-/.test(line)) continue;
        responses.push(line);
        if (step < lines.length) {
          socket.write(lines[step] + '\r\n');
          step += 1;
        } else {
          socket.end();
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(responses));
    socket.connect(port, host);
  });
}

function client(port: number, user: string, pass: string, host = '127.0.0.1') {
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user, pass },
  });
}

describe('SMTP front door — acceptance into the durable queue', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('accepts an authenticated submission, enqueues it durably and kicks the worker', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    const info = await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'Your sign-in link',
      html: '<p>Click <a href="https://example.com">here</a></p>',
      text: 'Click here: https://example.com',
    });

    expect(info.accepted).toEqual(['member@example.com']);
    expect(harness.worker.kick).toHaveBeenCalledTimes(1);
    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('the enqueued row carries the authenticated tenant as its domain, taken from the credential rather than re-derived from the message body', async () => {
    // This test's From used to be a domain unrelated to the credential
    // entirely, to prove `due[0].domain` came from `session.user` and not
    // from parsing the message. The sender-binding control
    // (senderBelongsToTenant in onMailFrom/onData) now refuses that
    // combination outright — a foreign-domain From can no longer reach the
    // queue at all, on either credential — so the two are inseparable for a
    // message that gets enqueued. What still distinguishes "read from the
    // credential" from "read from the body" is the display name/local
    // part, which the queued row must ignore just as before.
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Someone Else <noreply@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'Hi',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.domain).toBe('tenant-a.example.com');
  });

  it('two credentials, each sending as their own domain, are still throttled and queued as two separate submitters', async () => {
    // Both slots used to send `From:` one shared demo domain neither of
    // them owned, to prove throttle/queue identity is the authenticated
    // credential (tenants.domain, the AUTH username) and never anything the
    // message body claims. The sender-binding control now requires each
    // From to belong to its own sender's domain, so the shared-domain shape
    // is gone — each slot sends as itself instead, which still proves the
    // same property: two different credentials are attributed, ceilinged
    // and queued independently rather than being merged onto one identity.
    harness = await startHarness({ submitterMessagesPerMinute: 1 });
    const slotA = client(harness.port, 'tenant-a.example.com', 'key-a');
    const slotB = client(harness.port, 'tenant-b.example.com', 'key-b');

    await slotA.sendMail({
      from: 'Prospect <prospect@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'A',
      text: 'hi',
    });

    // Slot A's own ceiling (1/min) is already spent by the send above. Slot
    // B — a different credential, never having sent yet — is untouched by
    // that: its own first send still succeeds.
    await expect(
      slotA.sendMail({
        from: 'Prospect <prospect@tenant-a.example.com>',
        to: 'member@example.com',
        subject: 'A2',
        text: 'hi',
      })
    ).rejects.toThrow();
    await expect(
      slotB.sendMail({
        from: 'Prospect <prospect@tenant-b.example.com>',
        to: 'member@example.com',
        subject: 'B',
        text: 'hi',
      })
    ).resolves.toBeDefined();

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due.map((r) => r.domain).sort()).toEqual([
      'tenant-a.example.com',
      'tenant-b.example.com',
    ]);
  });

  it('carries subject/html/text through to the queued payload', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'Your sign-in link',
      html: '<p>hi</p>',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due[0]!.payload.subject).toBe('Your sign-in link');
    expect(due[0]!.payload.html).toContain('<p>hi</p>');
    expect(due[0]!.payload.text).toContain('hi');
  });

  it('carries a Reply-To header through to the queued payload when the message sets one', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      replyTo: 'support@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Hi',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due[0]!.payload.headers['Reply-To']).toContain('support@tenant-a.example.com');
  });

  it('falls back to the envelope sender and empty subject/text when a message carries no From/Subject/body', async () => {
    // A minimal, protocol-legal message: mailparser leaves `from`, `subject`
    // and `text` all undefined when the message has none of those, which is
    // exactly the case the `?? ''` fallbacks and the envelope-mailFrom
    // fallback below exist for — a message this bare still has to enqueue
    // something rather than crash on an unguarded property read.
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<envelope-sender@tenant-a.example.com>',
      'RCPT TO:<member@example.com>',
      'DATA',
      'To: member@example.com\r\n\r\n.',
    ]);

    expect(responses.some((line) => /^250 /.test(line))).toBe(true);
    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.payload.from).toBe('envelope-sender@tenant-a.example.com');
    expect(due[0]!.payload.subject).toBe('');
    expect(due[0]!.payload.text).toBe('');
  });

  it('rejects an unknown credential and never enqueues', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'wrong-key');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
    expect(harness.worker.kick).not.toHaveBeenCalled();
  });

  it('fails closed (an auth failure, not a crash) when verifyTenant rejects — a store/crypto error, not a failed check', async () => {
    harness = await startHarness();
    vi.spyOn(harness.store, 'verifyTenant').mockRejectedValueOnce(new Error('database is locked'));
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
    expect(harness.logs.some((line) => line.event === 'smtp_auth_failed')).toBe(true);
  });

  it('rejects a domain with no registered tenant and never enqueues', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'unregistered.example.com', 'anything');

    await expect(
      transport.sendMail({
        from: 'noreply@unregistered.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  describe('the visible sender is bound to the authenticated tenant', () => {
    it("refuses an envelope sender (MAIL FROM) outside the authenticated tenant's domain, with 553 5.7.1, and queues nothing", async () => {
      harness = await startHarness();
      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

      await expect(
        transport.sendMail({
          from: 'Attacker <noreply@evil.example>',
          to: 'member@example.com',
          subject: 'Envelope spoof',
          text: 'hi',
        })
      ).rejects.toMatchObject({ responseCode: 553 });

      expect(harness.store.countPendingRecipients()).toBe(0);
    });

    it("CONTROL: the tenant's own domain, as both envelope and header From, is accepted and enqueued", async () => {
      harness = await startHarness();
      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

      const info = await transport.sendMail({
        from: 'Tenant A <noreply@tenant-a.example.com>',
        to: 'member@example.com',
        subject: 'Legitimate',
        text: 'hi',
      });

      expect(info.accepted).toEqual(['member@example.com']);
      expect(harness.store.countPendingRecipients()).toBe(1);
    });

    it("refuses a header From outside the tenant's domain even when the envelope sender is legitimate, with 550 5.7.1, and queues nothing", async () => {
      harness = await startHarness();
      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

      await expect(
        transport.sendMail({
          envelope: { from: 'noreply@tenant-a.example.com', to: 'member@example.com' },
          from: 'Attacker <noreply@evil.example>',
          to: 'member@example.com',
          subject: 'Header From spoof',
          text: 'hi',
        })
      ).rejects.toMatchObject({ responseCode: 550 });

      expect(harness.store.countPendingRecipients()).toBe(0);
    });

    it("refuses a header Sender outside the tenant's domain even when From and envelope are both legitimate, with 550 5.7.1, and queues nothing", async () => {
      harness = await startHarness();
      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

      await expect(
        transport.sendMail({
          from: 'Tenant A <noreply@tenant-a.example.com>',
          sender: 'Attacker <noreply@evil.example>',
          to: 'member@example.com',
          subject: 'Header Sender spoof',
          text: 'hi',
        })
      ).rejects.toMatchObject({ responseCode: 550 });

      expect(harness.store.countPendingRecipients()).toBe(0);
    });

    it("accepts Ghost's real transactional sender shape for a tenant (mailFrom exactly as configured in ghost-tenant-blog's Pulumi.blog.yaml) and queues it", async () => {
      // `blog-infra:mailFrom: branchLeft blog <blog@branchleft.co.uk>` is the
      // live value for branchLeft's own tenant-zero blog — copied verbatim,
      // not paraphrased, so this proves the exact real shape is never
      // refused. The credential identity (AUTH username = the tenant's
      // registered domain) mirrors this suite's own existing convention,
      // e.g. 'tenant-a.example.com' above — every other test in this file
      // authenticates the same way.
      harness = await startHarness();
      harness.store.registerTenant('branchleft.co.uk', 'blog-key');
      const transport = client(harness.port, 'branchleft.co.uk', 'blog-key');

      const info = await transport.sendMail({
        from: 'branchLeft blog <blog@branchleft.co.uk>',
        to: 'member@example.com',
        subject: 'Your sign-in link',
        text: 'Click here',
      });

      expect(info.accepted).toEqual(['member@example.com']);
      expect(harness.store.countPendingRecipients()).toBe(1);
    });

    it('falls back to the already-verified envelope sender when a message has no header From at all — nothing left to spoof, so it is not refused', async () => {
      // Same minimal-message shape as the pre-existing "falls back to the
      // envelope sender" test above, retained deliberately: a header From
      // is only checked when it is actually present (see smtpFrontDoor.ts's
      // own comment on this), so this must still succeed under the
      // sender-binding control too.
      harness = await startHarness();
      const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

      const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
        'EHLO test',
        `AUTH PLAIN ${authPlain}`,
        'MAIL FROM:<envelope-sender@tenant-a.example.com>',
        'RCPT TO:<member@example.com>',
        'DATA',
        'To: member@example.com\r\n\r\n.',
      ]);

      expect(responses.some((line) => /^250 /.test(line))).toBe(true);
      expect(harness.store.countPendingRecipients()).toBe(1);
    });

    it('an enqueue failure (e.g. a SQLite error) returns a generic temporary 4xx, never the raw internal error text, over the real SMTP wire', async () => {
      harness = await startHarness();
      const enqueueSpy = vi.spyOn(harness.store, 'enqueueBatch').mockImplementation(() => {
        throw new Error(
          'SQLITE_CONSTRAINT: UNIQUE constraint failed: queue_recipients.batch_id, queue_recipients.recipient'
        );
      });
      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

      let caught: (Error & { responseCode?: number }) | undefined;
      try {
        await transport.sendMail({
          from: 'Tenant A <noreply@tenant-a.example.com>',
          to: 'member@example.com',
          subject: 'Hi',
          text: 'hi',
        });
      } catch (err) {
        caught = err as Error & { responseCode?: number };
      }

      expect(caught).toBeDefined();
      expect(caught!.responseCode).toBe(450);
      expect(caught!.message).not.toMatch(/SQLITE|constraint/i);
      expect(harness.store.countPendingRecipients()).toBe(0);

      enqueueSpy.mockRestore();
    });
  });

  it("rejects group/list-syntax recipient syntax (smtp-server's own grammar refuses it before this front door sees it)", async () => {
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<noreply@tenant-a.example.com>',
      'RCPT TO:<grp:attacker@evil.com;>',
      'QUIT',
    ]);

    const rcptResponse = responses.find((line) => /^5\d\d /.test(line));
    expect(rcptResponse).toBeDefined();
    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it("rejects a recipient address isSafeRecipientAddress itself refuses, via this front door's own onRcptTo check", async () => {
    // Unlike the group/list-syntax case above, `a"b@example.com` is
    // syntactically valid RFC 5321 (a quoted-string local part) — smtp-server's
    // own parser hands it straight to onRcptTo (verified: it does not 501
    // it first). It reaches isSafeRecipientAddress, which refuses the `"`,
    // and it is this front door's own 501 that comes back, not smtp-server's.
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<noreply@tenant-a.example.com>',
      'RCPT TO:<a"b@example.com>',
      'QUIT',
    ]);

    const rcptResponse = responses.find((line) => /^501 /.test(line));
    expect(rcptResponse).toBeDefined();
    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('accepts the first 50 recipients on a message, refuses the 51st with 452 4.5.3, and enqueues exactly those 50', async () => {
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');
    const recipients = Array.from({ length: 51 }, (_, i) => `member${i}@example.com`);

    // rawSmtpCommands' responses array is in strict protocol order, one
    // entry per final (non-continuation) response line: [banner, EHLO,
    // AUTH, MAIL FROM, ...one per RCPT TO, DATA's "354", the completed
    // message's "250", QUIT]. Named indices instead of a single slice
    // arithmetic expression, so a miscount fails loudly at the specific
    // assertion rather than silently comparing the wrong line.
    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<noreply@tenant-a.example.com>',
      ...recipients.map((address) => `RCPT TO:<${address}>`),
      'DATA',
      'Subject: many recipients\r\n\r\nBody\r\n.',
      'QUIT',
    ]);

    const rcptStart = 4; // banner, EHLO, AUTH, MAIL FROM
    const rcptResponses = responses.slice(rcptStart, rcptStart + recipients.length);
    expect(rcptResponses).toHaveLength(recipients.length);
    expect(rcptResponses.slice(0, 50).every((line) => /^250 /.test(line))).toBe(true);
    expect(rcptResponses[50]).toMatch(/^452 4\.5\.3 /);

    const dataAcceptedIndex = rcptStart + recipients.length; // "354 ..."
    expect(responses[dataAcceptedIndex]).toMatch(/^354 /);
    // A standard client sends the refused recipient in a separate message —
    // this one still completes for the 50 that were accepted.
    expect(responses[dataAcceptedIndex + 1]).toMatch(/^250 /);

    const due = harness.store.claimDueRecipients(Date.now() / 1000, 1000);
    expect(due).toHaveLength(50);
    expect(new Set(due.map((r) => r.recipient))).toEqual(new Set(recipients.slice(0, 50)));
    expect(due.some((r) => r.recipient === 'member50@example.com')).toBe(false);
  });

  it('rejects a message over the configured size cap and never enqueues it', async () => {
    harness = await startHarness({ maxMessageBytes: 1024 });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'x'.repeat(1024 * 50),
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('does not retain a message past its size cap — memory stays bounded while streaming, not just the eventual reply', async () => {
    // `stream.sizeExceeded` flips as data arrives, not only once the whole
    // message has been read — smtp-server counts bytes before this handler
    // ever sees each chunk, but never stops emitting them past the cap. A
    // submitter streaming far past the cap with DATA still open must not be
    // able to grow this process's memory in proportion to what it sends;
    // the reply-only assertion above cannot see that (it stays green even
    // if every byte past the cap is still being retained).
    const capBytes = 1024 * 1024;
    harness = await startHarness({ maxMessageBytes: capBytes });
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');
    const socket = new Socket();
    let buffer = '';
    const waitFor = (re: RegExp) =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (re.test(buffer)) {
            buffer = '';
            resolve();
          } else {
            setTimeout(check, 5);
          }
        };
        check();
      });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => socket.connect(harness.port, '127.0.0.1', resolve));
    await waitFor(/^220 /m);
    socket.write('EHLO test\r\n');
    await waitFor(/^250 /m);
    socket.write(`AUTH PLAIN ${authPlain}\r\n`);
    await waitFor(/^235 /m);
    socket.write('MAIL FROM:<a@tenant-a.example.com>\r\n');
    await waitFor(/^250 /m);
    socket.write('RCPT TO:<member@example.com>\r\n');
    await waitFor(/^250 /m);
    socket.write('DATA\r\n');
    await waitFor(/^354 /m);

    global.gc?.();
    const before = process.memoryUsage().arrayBuffers + process.memoryUsage().external;
    const line = 'X'.repeat(998) + '\r\n';
    const oneMiB = line.repeat(1024);
    const chunksToSend = 200; // ~200 MiB streamed against a 1 MiB cap
    for (let i = 0; i < chunksToSend; i++) {
      if (!socket.write(oneMiB)) {
        await new Promise((resolve) => socket.once('drain', resolve));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    global.gc?.();
    const duringMiB =
      (process.memoryUsage().arrayBuffers + process.memoryUsage().external - before) / 1048576;

    socket.write('\r\n.\r\n');
    await waitFor(/^5\d\d /m);
    socket.end();

    // Primary, exact assertion: the code's own count of bytes retained at
    // the moment it stopped retaining. Bounded relative to the configured
    // cap (never a fixed constant), so a sabotage that only raises the
    // effective threshold — rather than removing the bound outright — is
    // still caught: retention must stay under 2x the cap, not merely
    // "less than some large fixed number." process.memoryUsage() alone
    // can't provide this: it is noisy (allocator/GC-timing dependent) and
    // conflates this connection's retention with everything else running.
    const capExceededLine = harness.logs.find((line) => line.event === 'smtp_size_cap_exceeded');
    expect(capExceededLine).toBeDefined();
    const retainedBytes = capExceededLine!.fields.retainedBytes as number;
    expect(retainedBytes).toBeGreaterThan(capBytes * 0.9);
    expect(retainedBytes).toBeLessThan(capBytes * 2);

    // Secondary, correlating check against real process memory — looser and
    // relative to the cap too (not a fixed constant), since this measure is
    // inherently noisier than the exact byte count above.
    expect(duringMiB).toBeLessThan((capBytes / 1048576) * 100);
    expect(harness.store.countPendingRecipients()).toBe(0);
  }, 30000);

  describe('connection admission — unauthenticated pool vs. authenticated DATA phases', () => {
    // A peer that connects and never authenticates costs almost nothing —
    // one socket. Refusing NEW connections once too many of THOSE are open
    // (not once too many connections of any kind are open) means an
    // authenticated submitter's own connection is never counted against a
    // budget an unauthenticated attacker controls, and what actually costs
    // memory — an authenticated DATA phase — is capped on its own,
    // separately, below.

    async function connectAndWaitBanner(): Promise<Socket> {
      const socket = new Socket();
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^220 /m.test(buf)) {
            resolve();
          }
        });
        socket.on('error', reject);
        socket.connect(harness.port, '127.0.0.1');
      });
      return socket;
    }

    /**
     * Polls harness.logs for a line matching `predicate` instead of
     * sleeping a guessed duration — smtp_connection_queued (smtpFrontDoor.ts)
     * fires the instant a connection genuinely enters the per-source wait
     * queue, so this is a real readiness signal for "reached the queue",
     * not a timing assumption about smtp-server's own early-talker delay.
     * The bound is a safety net against hanging the suite on a real
     * regression, not the thing doing the waiting.
     */
    async function waitForLog(
      predicate: (line: CapturedLogLine) => boolean,
      timeoutMs = 2000
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!harness.logs.some(predicate)) {
        if (Date.now() > deadline) {
          throw new Error(`waitForLog: no matching line within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    interface RawSmtpSession {
      socket: Socket;
      write: (line: string) => void;
      waitFor: (re: RegExp) => Promise<void>;
    }

    /** A raw SMTP session with a `waitFor` helper, for tests that need to hold DATA open mid-transaction — nodemailer's own transport doesn't expose that. */
    function rawSmtpSession(): RawSmtpSession {
      const socket = new Socket();
      let buf = '';
      socket.on('data', (chunk: Buffer) => (buf += chunk.toString('utf8')));
      return {
        socket,
        write: (line: string) => {
          socket.write(line);
        },
        waitFor(re: RegExp): Promise<void> {
          return new Promise((resolve) => {
            const check = (): void => {
              if (re.test(buf)) {
                buf = '';
                resolve();
              } else {
                setTimeout(check, 5);
              }
            };
            check();
          });
        },
      };
    }

    /** Connects, authenticates as the given tenant and opens DATA, leaving it held open (no terminator sent). */
    async function authenticateAndOpenData(domain: string, key: string): Promise<RawSmtpSession> {
      const s = rawSmtpSession();
      await new Promise<void>((resolve) => s.socket.connect(harness.port, '127.0.0.1', resolve));
      await s.waitFor(/^220 /m);
      s.write('EHLO test\r\n');
      await s.waitFor(/^250 /m);
      s.write(`AUTH PLAIN ${Buffer.from(`\u0000${domain}\u0000${key}`).toString('base64')}\r\n`);
      await s.waitFor(/^235 /m);
      s.write(`MAIL FROM:<a@${domain}>\r\n`);
      await s.waitFor(/^250 /m);
      s.write('RCPT TO:<member@example.com>\r\n');
      await s.waitFor(/^250 /m);
      s.write('DATA\r\n');
      await s.waitFor(/^354 /m);
      return s;
    }

    /** Connects and authenticates, stopping right after AUTH succeeds — never opens DATA, so only the unauthenticated pool's own bookkeeping is exercised, not the separate DATA-phase guard. */
    async function authenticateOnly(domain: string, key: string): Promise<RawSmtpSession> {
      const s = rawSmtpSession();
      await new Promise<void>((resolve) => s.socket.connect(harness.port, '127.0.0.1', resolve));
      await s.waitFor(/^220 /m);
      s.write('EHLO test\r\n');
      await s.waitFor(/^250 /m);
      s.write(`AUTH PLAIN ${Buffer.from(`\u0000${domain}\u0000${key}`).toString('base64')}\r\n`);
      await s.waitFor(/^235 /m);
      return s;
    }

    it('releases the unauthenticated-pool slot on AUTH success — an authenticated connection held open never keeps counting against its own per-source cap', async () => {
      // Exactly what finding 1 needed: without this, an authenticated but
      // still-open connection would keep occupying its source's
      // unauthenticated budget forever (until it eventually closes), so a
      // burst of legitimate sign-ins that stay connected for a moment
      // after authenticating would still exhaust the per-source cap and
      // start queuing — or, past the queue bound, refusing — connections
      // that have nothing to do with the pool this cap protects.
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 3,
        maxUnauthenticatedConnections: 100,
        // Deliberately short: this proves the fourth connection is
        // admitted FAST, not merely "eventually, after queuing" — a wait
        // bound long enough to let queuing alone pass this test would
        // hide the exact regression this test exists to catch. If release
        // on AUTH success is broken, the fourth connection queues behind
        // the cap and this bound is what eventually refuses it — a clean,
        // fast assertion failure rather than a hung test.
        maxUnauthenticatedPerSourceWaitMs: 300,
      });

      // Fill the per-source cap (3) and hold every connection open,
      // authenticated — none of them close.
      const held = await Promise.all([
        authenticateOnly('tenant-a.example.com', 'key-a'),
        authenticateOnly('tenant-a.example.com', 'key-a'),
        authenticateOnly('tenant-a.example.com', 'key-a'),
      ]);

      // A fourth connection from the SAME source must be admitted at once,
      // well inside the 300ms wait bound above — proving it was never
      // actually queued, not merely that it didn't time out.
      const start = Date.now();
      const fourth = new Socket();
      const fourthResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        fourth.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) resolve(buf);
        });
        fourth.on('error', reject);
        fourth.connect(harness.port, '127.0.0.1');
      });
      const elapsedMs = Date.now() - start;

      expect(fourthResponse).toMatch(/^220 /);
      expect(elapsedMs).toBeLessThan(150);

      fourth.end();
      held.forEach((s) => s.socket.end());
    });

    it('refuses a new connection once maxUnauthenticatedConnections idle, never-authenticated connections are already open', async () => {
      harness = await startHarness({ maxUnauthenticatedConnections: 2 });

      const first = await connectAndWaitBanner();
      const second = await connectAndWaitBanner();

      const third = new Socket();
      const thirdResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        third.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) {
            resolve(buf);
          }
        });
        third.on('error', reject);
        third.connect(harness.port, '127.0.0.1');
      });

      expect(thirdResponse).toMatch(/^421 /);
      first.end();
      second.end();
      third.end();
    });

    it('refuses a new connection once maxUnauthenticatedConnectionsPerSource is already open from THAT source, before the global pool is even close to full', async () => {
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 2,
        maxUnauthenticatedConnections: 100,
      });

      const first = await connectAndWaitBanner();
      const second = await connectAndWaitBanner();

      const third = new Socket();
      const thirdResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        third.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) {
            resolve(buf);
          }
        });
        third.on('error', reject);
        third.connect(harness.port, '127.0.0.1');
      });

      expect(thirdResponse).toMatch(/^421 /);
      first.end();
      second.end();
      third.end();
    });

    it('one source at (and churning past) its own per-source cap never causes a 421 for a different source', async () => {
      // A global-only unauthenticated pool lets one credential-less source
      // churning connections — replacing each one the instant it's refused
      // or evicted — hold the whole pool full indefinitely without ever
      // needing a slot for more than a few seconds, denying a real,
      // different-source submitter (Ghost's own container) a slot at the
      // greeting. `::1` and `127.0.0.1` are two genuinely distinct
      // `remoteAddress` values reachable without any OS-level network
      // configuration, standing in for "the attacker's container" and "the
      // host's own Ghost".
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 5,
        maxUnauthenticatedConnections: 100,
        host: '::',
      });

      async function connectFrom(host: string): Promise<{ response: string; socket: Socket }> {
        const socket = new Socket();
        const response = await new Promise<string>((resolve, reject) => {
          let buf = '';
          socket.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (/^\d{3} /m.test(buf)) {
              resolve(buf);
            }
          });
          socket.on('error', reject);
          socket.connect(harness.port, host);
        });
        return { response, socket };
      }

      // Fill the attacker's own per-source budget (5 from ::1)...
      const attackerSockets: Socket[] = [];
      for (let i = 0; i < 5; i++) {
        const { response, socket } = await connectFrom('::1');
        expect(response).toMatch(/^220 /);
        attackerSockets.push(socket);
      }
      // ...and prove churning past it is refused, not silently admitted.
      const sixth = await connectFrom('::1');
      expect(sixth.response).toMatch(/^421 /);
      sixth.socket.end();

      // A DIFFERENT source (127.0.0.1), while the attacker sits at its own
      // cap, still gets the banner — never a 421.
      const legitimate = await connectFrom('127.0.0.1');
      expect(legitimate.response).toMatch(/^220 /);

      attackerSockets.forEach((s) => s.end());
      legitimate.socket.end();
    });

    it('a genuine concurrent burst from one source — not a sequence awaited one at a time — still never blocks a different source', async () => {
      // The sequential test above proves the cap logic; it does not prove
      // the WIRING survives real concurrency. smtp-server adds every
      // accepted socket to its own `connections` Set the instant the TCP
      // handshake completes, then holds it — unchecked by anything — for a
      // fixed ~100ms "early talker" delay before onConnect ever runs
      // (connectionReady(), smtp-connection.js). A live churn attack that
      // opens many connections from one source at once, not one at a time,
      // lands a burst of them in that Set together, all still pending
      // their own admission check — which is exactly what defeated the
      // first version of this fix (proven against real Ghost 6.55.0: a
      // single churning source pinned the global count above its cap using
      // connections that were themselves about to be refused, and a
      // different, well-behaved source got a real 421). Firing many
      // connects here without awaiting each one in turn is what actually
      // exercises that window.
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 3,
        maxUnauthenticatedConnections: 10,
        host: '::',
      });

      let stop = false;
      const activeAttackers: Socket[] = [];

      function churnOnce(): void {
        if (stop) return;
        const socket = new Socket();
        activeAttackers.push(socket);
        let sawFirstLine = false;
        socket.on('data', (chunk: Buffer) => {
          if (!sawFirstLine && /^\d{3}/.test(chunk.toString('utf8'))) {
            sawFirstLine = true;
          }
        });
        socket.on('error', () => {});
        socket.on('close', () => {
          const idx = activeAttackers.indexOf(socket);
          if (idx !== -1) activeAttackers.splice(idx, 1);
          if (!stop) churnOnce();
        });
        socket.connect(harness.port, '::1');
      }

      // 30 concurrent workers, none awaited individually — every connect
      // below fires before any of them has resolved, which is the shape
      // that lands a real burst in smtp-server's own Set together.
      for (let i = 0; i < 30; i++) churnOnce();

      // Let the burst run long enough to cross smtp-server's ~100ms
      // pre-check dwell window several times over.
      await new Promise((r) => setTimeout(r, 400));

      const legitimate = new Socket();
      const legitimateResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        legitimate.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) resolve(buf);
        });
        legitimate.on('error', reject);
        legitimate.connect(harness.port, '127.0.0.1');
      });

      stop = true;
      activeAttackers.forEach((s) => s.destroy());
      legitimate.end();

      expect(legitimateResponse).toMatch(/^220 /);
    });

    it('a legitimate concurrent burst from ONE source, well past its own per-source cap, is never refused — every send completes', async () => {
      // The exact shape ordinary traffic produces, not an attack: several
      // members signing in at once each open their own connection from the
      // same host. A per-source cap that refuses anything past its own
      // number turns that into lost mail. Twenty concurrent sends from one
      // source, cap held at 5, must all still complete — the excess waits
      // for the ordinary trickle of releases (each one authenticating)
      // rather than being turned away.
      //
      // maxUnauthenticatedPerSourceWaitMs is set explicitly here, well
      // past the harness default of 2000ms, rather than left to it. What
      // this test asserts is a correctness property — all 20 sends
      // eventually complete, none refused — not that they do so within
      // some particular wall-clock window, and the harness default was
      // never chosen with that property in mind. Even with AUTH's scrypt
      // check off the event loop (crypto.ts), the wait a queued
      // connection can tolerate before every earlier one has authenticated
      // still scales with real CPU time, which this suite does not
      // control. 10s is comfortably under nodemailer's own default
      // greeting timeout, so it changes nothing about what a real client
      // would tolerate.
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 5,
        maxUnauthenticatedConnections: 100,
        maxUnauthenticatedPerSourceWaitMs: 10_000,
        maxConcurrentDataPhases: 100,
        maxConcurrentDataPhasesPerSubmitter: 100,
      });

      const sends = Array.from({ length: 20 }, (_, i) => {
        const transport = client(harness.port, 'tenant-a.example.com', 'key-a');
        return transport.sendMail({
          from: 'Tenant A <noreply@tenant-a.example.com>',
          to: `member${i}@example.com`,
          subject: 'Your sign-in link',
          text: 'Click here',
        });
      });

      const results = await Promise.all(sends);
      expect(results).toHaveLength(20);
    }, 20000);

    it('a burst deeper than the per-source wait queue is refused outright, not queued without bound', async () => {
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 2,
        maxUnauthenticatedConnections: 100,
        maxUnauthenticatedPerSourceWaitQueueDepth: 3,
        maxUnauthenticatedPerSourceWaitMs: 60_000,
      });

      // Fill the instant-admit cap (2) — these two get a banner right away.
      const admitted = [await connectAndWaitBanner(), await connectAndWaitBanner()];

      // Fill the wait queue (3) — these three are queued behind the cap
      // above, so no banner arrives for them; opened without waiting for
      // one, and given a moment to actually reach the queue.
      const queued: Socket[] = [];
      for (let i = 0; i < 3; i++) {
        const s = new Socket();
        s.on('error', () => {});
        s.connect(harness.port, '127.0.0.1');
        queued.push(s);
      }
      await new Promise((r) => setTimeout(r, 100));

      const sixth = new Socket();
      const sixthResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        sixth.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) resolve(buf);
        });
        sixth.on('error', reject);
        sixth.connect(harness.port, '127.0.0.1');
      });

      // Refused immediately (queue-full), not after waiting out the 60s
      // bound above — this test's own timeout is proof it didn't wait.
      expect(sixthResponse).toMatch(/^421 /);
      expect(
        harness.logs.some(
          (line) =>
            line.event === 'smtp_connection_refused' &&
            line.fields.reason === 'max_unauthenticated_connections_per_source_queue_full'
        )
      ).toBe(true);

      sixth.end();
      admitted.forEach((s) => s.destroy());
      queued.forEach((s) => s.destroy());
    });

    it('a queued connection that waits past the bound is refused with a distinct reason', async () => {
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 1,
        maxUnauthenticatedConnections: 100,
        maxUnauthenticatedPerSourceWaitQueueDepth: 5,
        maxUnauthenticatedPerSourceWaitMs: 150,
      });

      const holder = await connectAndWaitBanner();

      const waiter = new Socket();
      const waiterResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        waiter.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) resolve(buf);
        });
        waiter.on('error', reject);
        waiter.connect(harness.port, '127.0.0.1');
      });

      expect(waiterResponse).toMatch(/^421 /);
      expect(
        harness.logs.some(
          (line) =>
            line.event === 'smtp_connection_refused' &&
            line.fields.reason === 'max_unauthenticated_connections_per_source_wait_timeout'
        )
      ).toBe(true);

      holder.end();
      waiter.end();
    });

    it('a connection that drops while still queued is withdrawn cleanly — never admitted, and the slot it would have leaked stays usable', async () => {
      harness = await startHarness({
        maxUnauthenticatedConnectionsPerSource: 1,
        maxUnauthenticatedConnections: 100,
        maxUnauthenticatedPerSourceWaitQueueDepth: 5,
        maxUnauthenticatedPerSourceWaitMs: 5000,
      });

      const holder = await connectAndWaitBanner();

      const waiter = new Socket();
      const waiterClosed = new Promise<void>((resolve) => waiter.on('close', resolve));
      waiter.connect(harness.port, '127.0.0.1');
      // Wait for the real readiness signal — smtp_connection_queued fires
      // only once this connection has genuinely entered the per-source
      // wait queue (see waitForLog's own comment). A fixed sleep here is
      // not safe: smtp-server holds every connection for its own ~100ms
      // early-talker check before onConnect ever runs, so a short enough
      // sleep destroys the socket before it reaches the queue at all —
      // proving nothing about the cancel-on-early-close path this test
      // exists for (confirmed by sabotaging onEarlyClose to a no-op: with
      // a 50ms sleep the test stayed green regardless).
      await waitForLog(
        (line) =>
          line.event === 'smtp_connection_queued' && line.fields.remoteAddress === '127.0.0.1'
      );
      waiter.destroy();
      await waiterClosed;

      // The slot the holder still occupies is untouched by the dropped
      // waiter — releasing it now must not "admit" a connection that no
      // longer exists (smtp-server would have nothing to write a response
      // to), and must not appear in the logs as either admitted or refused.
      holder.end();

      // The proof that actually distinguishes a working cancel from a
      // no-op one: a FRESH, live connection from the same source must get
      // the slot the holder just freed. cancel() leaving the waiter in the
      // queue (the sabotage below) is invisible to the two assertions
      // above — wrapSlot's release() would silently hand the freed slot to
      // that dead entry instead, calling its onResult with { admitted:
      // true } and attaching the release-on-close listener to a socket
      // that already closed, which will never fire it again. Nothing logs
      // an error for that — the leak is silent, and the next legitimate
      // connection from this source is the one that pays for it.
      const fresh = new Socket();
      const freshResponse = await new Promise<string>((resolve, reject) => {
        let buf = '';
        fresh.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^\d{3} /m.test(buf)) resolve(buf);
        });
        fresh.on('error', reject);
        fresh.connect(harness.port, '127.0.0.1');
      });
      fresh.end();

      expect(freshResponse).toMatch(/^220 /);
      expect(
        harness.logs.some(
          (line) =>
            line.event === 'smtp_connection_refused' && line.fields.remoteAddress === '127.0.0.1'
        )
      ).toBe(false);
    });

    it('closes an unauthenticated connection once its auth deadline passes — even one sending NOOP to stay superficially active', async () => {
      // The exact shape an unauthenticated attacker can use to survive
      // smtp-server's own idle timeout without ever authenticating: send
      // some command periodically. The deadline below is a fixed timer from
      // connect time, not reset by activity, so it closes the connection
      // regardless. NOOP is sent slowly (every 300ms) and the deadline is
      // short (200ms) so this test's own closure is caused by THIS
      // mechanism, not by smtp-server's separate, built-in
      // maxAllowedUnauthenticatedCommands limit (default 10) — sabotaging
      // this deadline alone must leave the connection open for many seconds
      // (until the default `it()` timeout), not seconds.
      harness = await startHarness({ maxUnauthenticatedConnections: 1, authDeadlineMs: 200 });

      const socket = new Socket();
      const closed = new Promise<void>((resolve) => socket.once('close', resolve));
      let buf = '';
      socket.on('data', (chunk: Buffer) => (buf += chunk.toString('utf8')));
      await new Promise<void>((resolve, reject) => {
        socket.on('error', reject);
        socket.connect(harness.port, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (/^220 /m.test(buf)) {
            resolve();
          } else {
            setTimeout(check, 5);
          }
        };
        check();
      });
      const noopInterval = setInterval(() => socket.write('NOOP\r\n'), 300);

      const bannerAt = Date.now();
      await closed;
      const elapsedMs = Date.now() - bannerAt;
      clearInterval(noopInterval);

      // Bounds which mechanism closed it: the deadline (200ms) fires well
      // under a second; smtp-server's own built-in unauthenticated-command
      // counter (10 commands at this test's 300ms NOOP interval) would take
      // ~3s. A test that only waited for 'close' with no bound would still
      // pass if this deadline were sabotaged away entirely.
      expect(elapsedMs).toBeLessThan(1000);

      // The slot it held is now free — a fresh connection succeeds under
      // the same cap of 1.
      const next = await connectAndWaitBanner();
      next.end();
    });

    it('an authenticated submission succeeds once idle, never-authenticating connections holding the pool have been evicted by their deadline', async () => {
      // The finding this defends against: an unauthenticated peer holds
      // every unauthenticated slot, so a real submitter's own (initially
      // unauthenticated) connection is refused at the greeting before it
      // ever gets to try AUTH. Fixed by a deadline short enough that the
      // attacker's slots free up well within the time a real client would
      // retry.
      // A generous deadline relative to this test's own connection setup
      // time (each connect below is a real TCP round trip): short enough to
      // still prove eviction happens well within a real client's retry
      // window, long enough that the attacker connections are reliably both
      // open before either gets evicted, which is what "pool full" needs.
      harness = await startHarness({ maxUnauthenticatedConnections: 2, authDeadlineMs: 500 });

      const attacker1 = await connectAndWaitBanner();
      const attacker2 = await connectAndWaitBanner();
      // Pool is now full of idle, never-authenticating connections.
      const blocked = new Socket();
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        blocked.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (/^421 /m.test(buf)) resolve();
        });
        blocked.on('error', reject);
        blocked.connect(harness.port, '127.0.0.1');
      });
      blocked.end();

      // Wait past the deadline — the attacker's connections are closed
      // without them doing anything, freeing the pool.
      await new Promise((resolve) => setTimeout(resolve, 600));
      attacker1.destroy();
      attacker2.destroy();

      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');
      await expect(
        transport.sendMail({
          from: 'noreply@tenant-a.example.com',
          to: 'member@example.com',
          subject: 'Hi',
          text: 'hi',
        })
      ).resolves.toBeDefined();
    });

    it('bounds concurrent authenticated DATA phases globally, independent of the unauthenticated pool', async () => {
      // What actually costs memory: too many messages being received at
      // once, not too many connections open. A generous unauthenticated
      // pool never gates this — only authenticated DATA phases do.
      harness = await startHarness({
        maxConcurrentDataPhases: 1,
        maxConcurrentDataPhasesPerSubmitter: 1,
      });

      const first = await authenticateAndOpenData('tenant-a.example.com', 'key-a');
      const second = await authenticateAndOpenData('tenant-b.example.com', 'key-b');

      // The second submitter's DATA is refused even though it is a
      // DIFFERENT identity — the cap is global, not just per-submitter.
      // `waitFor` resolving on a 4xx/5xx pattern IS the assertion: it would
      // hang (and fail the test's own timeout) if no such reply arrived.
      second.write('some body\r\n.\r\n');
      await second.waitFor(/^[45]\d\d /m);

      first.write('\r\n.\r\n');
      first.socket.end();
      second.socket.end();
    });

    it('bounds concurrent authenticated DATA phases per submitter, independently of a different submitter', async () => {
      harness = await startHarness({
        maxConcurrentDataPhasesPerSubmitter: 1,
        maxConcurrentDataPhases: 5,
      });

      const held = await authenticateAndOpenData('tenant-a.example.com', 'key-a');

      // Same submitter, second concurrent DATA phase: refused.
      const transportA2 = client(harness.port, 'tenant-a.example.com', 'key-a');
      await expect(
        transportA2.sendMail({
          from: 'noreply@tenant-a.example.com',
          to: 'member@example.com',
          subject: 'A2',
          text: 'hi',
        })
      ).rejects.toThrow();

      // A different submitter is unaffected by tenant-a's own per-submitter cap.
      const transportB = client(harness.port, 'tenant-b.example.com', 'key-b');
      await expect(
        transportB.sendMail({
          from: 'noreply@tenant-b.example.com',
          to: 'member@example.com',
          subject: 'B',
          text: 'hi',
        })
      ).resolves.toBeDefined();

      held.write('\r\n.\r\n');
      held.socket.end();
    });

    it("releases one of a submitter's two concurrent DATA phases without freeing its budget entirely", async () => {
      // Exercises the decrement path (2 in flight -> 1), not just the
      // delete-the-entry path (1 in flight -> 0) the tests above already
      // cover.
      harness = await startHarness({
        maxConcurrentDataPhasesPerSubmitter: 2,
        maxConcurrentDataPhases: 5,
      });

      const first = await authenticateAndOpenData('tenant-a.example.com', 'key-a');
      const second = await authenticateAndOpenData('tenant-a.example.com', 'key-a');

      // A third, still concurrent with the first two, is refused.
      const third = client(harness.port, 'tenant-a.example.com', 'key-a');
      await expect(
        third.sendMail({
          from: 'noreply@tenant-a.example.com',
          to: 'member@example.com',
          subject: 'A3',
          text: 'hi',
        })
      ).rejects.toThrow();

      // Releasing one of the two (down to 1 in flight, not 0) frees exactly
      // one slot back.
      first.write('\r\n.\r\n');
      await first.waitFor(/^250 /m);

      const fourth = client(harness.port, 'tenant-a.example.com', 'key-a');
      await expect(
        fourth.sendMail({
          from: 'noreply@tenant-a.example.com',
          to: 'member@example.com',
          subject: 'A4',
          text: 'hi',
        })
      ).resolves.toBeDefined();

      second.write('\r\n.\r\n');
      second.socket.end();
      first.socket.end();
    });

    it('releases the concurrency slot when the connection drops mid-DATA — repeated drops never leak the budget permanently', async () => {
      // smtp-server detaches the data stream (unpipes it and sets it to
      // null — _onClose, smtp-connection.js) without emitting 'end' or
      // 'error' on it when the socket closes mid-transfer, so relying on
      // those two events
      // alone leaked the slot forever on every dropped connection, not
      // only a deliberately malicious one — an ordinary network blip or
      // container restart mid-send does this too. Six drops (one more than
      // maxConcurrentDataPhasesPerSubmitter) proves the release genuinely
      // happens every time, not just enough times to look like it by
      // coincidence.
      harness = await startHarness({
        maxConcurrentDataPhasesPerSubmitter: 5,
        maxConcurrentDataPhases: 20,
      });

      for (let i = 0; i < 6; i++) {
        const dropped = await authenticateAndOpenData('tenant-a.example.com', 'key-a');
        dropped.socket.destroy();
        // Give the socket's own 'close' event, and this module's listener
        // for it, a moment to fire before the next iteration starts.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const transport = client(harness.port, 'tenant-a.example.com', 'key-a');
      await expect(
        transport.sendMail({
          from: 'noreply@tenant-a.example.com',
          to: 'member@example.com',
          subject: 'After six mid-DATA drops',
          text: 'hi',
        })
      ).resolves.toBeDefined();
    });
  });

  it('refuses a connection from outside the configured source allow-list', async () => {
    // Only a range 127.0.0.1 doesn't belong to — proves the listener really
    // does turn away a source it isn't configured to trust, not just that
    // it never gets exercised because tests always run from loopback.
    harness = await startHarness({ allowedSourceCidrs: ['10.0.0.0/8'] });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('applies the shipped default allow-list when none is configured', async () => {
    // Exercises `createSmtpFrontDoor`'s own
    // `opts.allowedSourceCidrs ?? DEFAULT_ALLOWED_SOURCE_CIDRS` fallback for
    // real (the option is genuinely omitted here, not defaulted by the test
    // harness's own `DEFAULT_CIDRS ?? ...`). "Refuses a public source"
    // against this same shipped default is already proven directly by
    // `isAllowedSource`'s own test matrix above — this test's job is only to
    // prove the fallback wires that default in at all when the option is
    // omitted, via a real connection.
    harness = await startHarness({ omitAllowedSourceCidrs: true });
    const loopback = client(harness.port, 'tenant-a.example.com', 'key-a');
    await expect(
      loopback.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).resolves.toBeDefined();
    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('rate-limits a submitter that exceeds its per-minute ceiling, keyed on identity not address', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1 });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'First',
      text: 'hi',
    });

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Second, over the ceiling',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('a different tenant is never limited by another tenant exhausting its ceiling', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1 });
    const a = client(harness.port, 'tenant-a.example.com', 'key-a');
    const b = client(harness.port, 'tenant-b.example.com', 'key-b');

    await a.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'm@example.com',
      subject: 'A',
      text: 'hi',
    });
    await expect(
      a.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'm@example.com',
        subject: 'A2',
        text: 'hi',
      })
    ).rejects.toThrow();

    // tenant-b's own ceiling is untouched by tenant-a's connections above.
    await expect(
      b.sendMail({
        from: 'noreply@tenant-b.example.com',
        to: 'm@example.com',
        subject: 'B',
        text: 'hi',
      })
    ).resolves.toBeDefined();

    expect(harness.store.countPendingRecipients()).toBe(2);
  });

  it('the same tenant sharing one ceiling across an IPv4 and an IPv6 connection, keyed correctly', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1, host: '::' });
    const overV4 = client(harness.port, 'tenant-a.example.com', 'key-a', '127.0.0.1');
    const overV6 = client(harness.port, 'tenant-a.example.com', 'key-a', '::1');

    await overV4.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Over IPv4',
      text: 'hi',
    });

    // Same submitter identity, different address family — must share the
    // bucket the first send already spent, not get a fresh one because the
    // connection happened to arrive over IPv6.
    await expect(
      overV6.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Over IPv6, should be limited',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('two different tenants connecting over the same IPv6 address get independent ceilings', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1, host: '::' });
    const a = client(harness.port, 'tenant-a.example.com', 'key-a', '::1');
    const b = client(harness.port, 'tenant-b.example.com', 'key-b', '::1');

    await a.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'm@example.com',
      subject: 'A',
      text: 'hi',
    });
    await expect(
      b.sendMail({
        from: 'noreply@tenant-b.example.com',
        to: 'm@example.com',
        subject: 'B',
        text: 'hi',
      })
    ).resolves.toBeDefined();

    expect(harness.store.countPendingRecipients()).toBe(2);
  });
});

describe('SMTP front door — answered at once, sabotage-provable', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('acknowledges well under a second with nothing draining the queue', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    const start = Date.now();
    await transport.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Timed',
      text: 'hi',
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    // The worker was told to kick, but this test never gave it anywhere
    // reachable to send to — the ack above did not wait on that call
    // resolving anything, only on the durable write.
    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('still acknowledges within a bound when the worker never goes idle — the ack is not coupled to the drain', async () => {
    // A worker whose `whenIdle()` resolves immediately can't distinguish "no
    // coupling" from "coupled but fast" — this one never resolves at all, so
    // an ack wired to wait on it hangs forever rather than merely running
    // slow.
    harness = await startHarness({ workerNeverIdle: true });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    const start = Date.now();
    await transport.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Timed, worker never idle',
      text: 'hi',
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(harness.store.countPendingRecipients()).toBe(1);
  }, 10000);
});

describe('SMTP front door — runtime server errors are logged, not swallowed', () => {
  let harness: Harness;
  let second: SmtpFrontDoor | undefined;

  afterEach(async () => {
    await second?.close();
    await harness?.close();
  });

  it('logs smtp_server_error when the underlying net.Server reports one (e.g. a second listener on the same port)', async () => {
    harness = await startHarness();

    const store2 = createSqliteStore(':memory:');
    const { logger: logger2, lines: logs2 } = createTestLogger();
    second = createSmtpFrontDoor({
      store: store2,
      worker: {
        kick: vi.fn(),
        whenIdle: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        status: () => ({ lastTickAt: null, stopped: false }),
      },
      log: logger2,
      maxMessageBytes: 1024 * 1024,
      maxRecipientsPerMessage: 50,
      maxUnauthenticatedConnectionsPerSource: 20,
      maxUnauthenticatedConnections: 20,
      maxUnauthenticatedPerSourceWaitQueueDepth: 50,
      maxUnauthenticatedPerSourceWaitMs: 2000,
      authDeadlineMs: 5000,
      maxConcurrentDataPhases: 20,
      maxConcurrentDataPhasesPerSubmitter: 5,
      submitterMessagesPerMinute: 120,
    });

    // Binding a second listener to a port already in use makes the
    // underlying net.Server emit 'error' (EADDRINUSE) — the same event
    // this module's persistent `server.on('error', ...)` handler logs,
    // exercising it independently of the once-listener listen() itself
    // uses to reject its own promise.
    await expect(second.listen(harness.port, '127.0.0.1')).rejects.toThrow();

    expect(logs2.some((line) => line.event === 'smtp_server_error')).toBe(true);
    store2.close();
  });
});
