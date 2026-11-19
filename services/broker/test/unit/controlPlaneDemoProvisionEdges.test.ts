import { describe, expect, it } from 'vitest';
import type { DemoBroker } from '../../src/controlPlaneDemoBroker.js';
import {
  DemoRecordMissingError,
  provisionDemo,
  type Arrival,
  type LifecycleStore,
} from '../../src/controlPlaneDemoProvision.js';
import {
  DEMO_ID,
  SLOT,
  countingGate,
  depsFor,
  fakeStore,
  recordingMailer,
  virtualClock,
} from '../helpers/demoProvisionRig.js';
import { scripted } from '../helpers/scriptedBroker.js';

// The step's own decisions, against a host that answers as scripted. The real
// broker proves the host side; these pin what the worker does with each answer.

function run(
  broker: DemoBroker,
  store = fakeStore(() => 1_700_000_100_000),
  sendArrival?: (arrival: Arrival) => Promise<void>
) {
  const clock = virtualClock();
  const logs: string[] = [];
  return {
    store,
    clock,
    logs,
    result: provisionDemo(
      depsFor(store, broker, countingGate(), clock, logs, sendArrival),
      DEMO_ID,
      SLOT
    ),
  };
}

describe('provisionDemo: what the worker does with each answer', () => {
  it('a host that never answers is sent the same reconcile, then reset and tried once more, then FAILED as unanswered', async () => {
    const broker = scripted({ reconcile: [{ kind: 'unanswered' }] });
    const { result, store } = run(broker);
    const outcome = await result;
    // resendLimit 2: three sends per attempt, two attempts.
    expect(broker.sent).toBe(6);
    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'unanswered', attempts: 2 });
    expect(store.state()).toBe('FAILED');
    expect(broker.resets).toBe(2);
  });

  it('a slot that goes to an error phase after the reconcile is a failure at once, not at the deadline', async () => {
    const broker = scripted({ status: [{ phase: 'error', healthy: false }] });
    const { result, clock } = run(broker);
    const began = clock.nowMs();
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'unhealthy', attempts: 2 });
    expect(clock.nowMs()).toBe(began);
  });

  it('a status that cannot be read is tried again until the host answers healthy', async () => {
    const broker = scripted({
      status: [undefined, undefined, { phase: 'running', healthy: true }],
    });
    const { result, clock } = run(broker);
    const began = clock.nowMs();
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'LIVE', attempts: 1 });
    expect(clock.nowMs() - began).toBe(2000);
  });

  it('a status that is never readable ends at the timeout, not never', async () => {
    const broker = scripted({ status: [undefined] });
    const { result } = run(broker);
    expect(await result).toMatchObject({ state: 'FAILED', reason: 'unhealthy' });
  });

  it('a final reset that does not free the slot flags it for a person and still ends FAILED', async () => {
    const broker = scripted({
      reconcile: [{ kind: 'failed' }],
      reset: ['free', 'unanswered'],
    });
    const { result, store } = run(broker);
    expect(await result).toMatchObject({
      state: 'FAILED',
      reason: 'broker-error',
      attempts: 2,
      slotNeedsAttention: true,
      // The slot needs a person, so its hostname is not retired: that is what
      // keeps the data layer from offering the slot again.
      hostnameRetired: false,
    });
    expect(store.retired).toEqual([]);
  });

  it('a descriptor this worker cannot build sends nothing and ends FAILED as internal, without touching the slot', async () => {
    const broker = scripted();
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs);
    const gate = {
      async issue() {
        return { passphrase: 'p', argon2idHash: '   ' };
      },
    };
    const outcome = await provisionDemo(depsFor(store, broker, gate, clock), DEMO_ID, SLOT);
    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'internal', attempts: 1 });
    expect(broker.sent).toBe(0);
    expect(broker.resets).toBe(0);
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
  });

  it('allocates the hostname once: a demo that already has its label is not given another', async () => {
    const clock = virtualClock();
    const base = fakeStore(clock.nowMs);
    let allocations = 0;
    const store: LifecycleStore = {
      ...base,
      hostname: async () => 'alreadyallocatedlabel2',
      allocateHostname: async () => {
        allocations += 1;
        return 'neverusedlabel234567';
      },
      transition: base.transition,
    };
    const outcome = await provisionDemo(
      depsFor(store, scripted(), countingGate(), clock),
      DEMO_ID,
      SLOT
    );
    expect(allocations).toBe(0);
    expect(outcome).toMatchObject({ state: 'LIVE', hostname: 'alreadyallocatedlabel2' });
  });

  it('refuses to start without a recorded request or without a term, and sends nothing', async () => {
    const clock = virtualClock();
    const base = fakeStore(clock.nowMs);
    const broker = scripted();
    const noRequest: LifecycleStore = { ...base, request: async () => undefined };
    await expect(
      provisionDemo(depsFor(noRequest, broker, countingGate(), clock), DEMO_ID, SLOT)
    ).rejects.toMatchObject({ name: 'DemoRecordMissingError', what: 'request' });
    const noTerm: LifecycleStore = {
      ...base,
      transition: async () => ({ toState: 'PROVISIONING', leaseEndsAt: null }),
    };
    const error = await provisionDemo(
      depsFor(noTerm, broker, countingGate(), clock),
      DEMO_ID,
      SLOT
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoRecordMissingError);
    expect(broker.sent).toBe(0);
  });

  it('a reconcile still running on the host (locked) is sent again after a wait, never read as a refusal, and goes LIVE with no reset', async () => {
    const broker = scripted({
      reconcile: [{ kind: 'locked' }, { kind: 'locked' }, { kind: 'running', colour: 'a' }],
    });
    const { result, clock, store } = run(broker);
    const began = clock.nowMs();
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'LIVE', attempts: 1 });
    expect(broker.sent).toBe(3);
    expect(broker.resets).toBe(0);
    expect(clock.nowMs() - began).toBe(2000);
    expect(store.moves).toEqual(['PROVISIONING', 'LIVE']);
  });

  it('a reconcile locked past the provision timeout ends FAILED as unanswered, with the slot reset: it is ours and not refused', async () => {
    const broker = scripted({ reconcile: [{ kind: 'locked' }] });
    const { result, store } = run(broker);
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'unanswered', attempts: 2 });
    expect(broker.resets).toBe(2);
    expect(store.retired).toHaveLength(1);
    // Bounded by the timeout (30 s of 1 s waits), not a send per answer.
    expect(broker.sent).toBeLessThan(100);
  });

  it('a reset met by a lock is tried again after a wait: the retry goes ahead once the slot frees', async () => {
    const broker = scripted({
      reconcile: [{ kind: 'failed' }, { kind: 'running', colour: 'a' }],
      reset: ['locked', 'locked', 'free'],
    });
    const { result } = run(broker);
    expect(await result).toMatchObject({ state: 'LIVE', attempts: 2 });
    expect(broker.resets).toBe(3);
  });

  it('a reset locked past the provision timeout flags the slot for a person and keeps its hostname', async () => {
    const broker = scripted({ reconcile: [{ kind: 'failed' }], reset: ['locked'] });
    const { result, store } = run(broker);
    expect(await result).toMatchObject({
      state: 'FAILED',
      reason: 'reset-failed',
      slotNeedsAttention: true,
      hostnameRetired: false,
    });
    expect(store.retired).toEqual([]);
  });

  it('a throw after PROVISIONING is caught: the demo is FAILED, never left PROVISIONING, and the slot is flagged and held', async () => {
    const throwing: DemoBroker = {
      ...scripted(),
      reconcile: async () => {
        throw new RangeError('a signing key of the wrong length');
      },
    };
    const { result, store, logs } = run(throwing);
    const outcome = await result;
    expect(outcome).toMatchObject({
      state: 'FAILED',
      reason: 'internal',
      slotNeedsAttention: true,
      hostnameRetired: false,
    });
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
    expect(store.retired).toEqual([]);
    expect(logs.join('\n')).toContain('threw (RangeError)');
  });

  it('a throw after FAILED is already recorded does not record it twice', async () => {
    const inner = scripted({ reconcile: [{ kind: 'failed' }], reset: ['free', 'free'] });
    let resets = 0;
    const throwing: DemoBroker = {
      ...inner,
      reset: async (slot) => {
        resets += 1;
        // The first reset is the retry's; the second is the final one, after FAILED.
        if (resets === 2) throw new Error('tunnel dropped');
        return inner.reset(slot);
      },
    };
    const { result, store } = run(throwing);
    expect(await result).toMatchObject({ state: 'FAILED', slotNeedsAttention: true });
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
  });

  it('when the store cannot record FAILED either, the original error is thrown rather than hidden', async () => {
    const clock = virtualClock();
    const base = fakeStore(clock.nowMs);
    const store: LifecycleStore = {
      ...base,
      transition: async (demoId, to) => {
        if (to === 'FAILED') throw new Error('database down');
        return base.transition(demoId, to);
      },
    };
    const throwing: DemoBroker = {
      ...scripted(),
      reconcile: async () => {
        throw new RangeError('first fault');
      },
    };
    await expect(
      provisionDemo(depsFor(store, throwing, countingGate(), clock), DEMO_ID, SLOT)
    ).rejects.toThrow('first fault');
  });

  it('a mail that cannot be sent fails the attempt: the slot is reset and the retry mails a fresh passphrase before LIVE', async () => {
    const broker = scripted();
    const mailer = recordingMailer();
    mailer.fail = true;
    let calls = 0;
    const store = fakeStore(() => 1_700_000_100_000);
    const stateAtMail: string[] = [];
    const { result } = run(broker, store, async (arrival) => {
      calls += 1;
      stateAtMail.push(store.state());
      if (calls === 2) mailer.fail = false;
      await mailer.send(arrival);
    });
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'LIVE', attempts: 2 });
    expect(broker.resets).toBe(1);
    expect(mailer.sent.map((a) => a.passphrase)).toEqual(['pass-2']);
    expect(stateAtMail).toEqual(['PROVISIONING', 'PROVISIONING']);
  });

  it('a mail that never goes is FAILED as mail, never LIVE: no demo is LIVE with a passphrase nobody was sent', async () => {
    const broker = scripted();
    const mailer = recordingMailer();
    mailer.fail = true;
    const { result, store } = run(broker, undefined, mailer.send);
    const outcome = await result;
    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'mail', attempts: 2 });
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
    expect(mailer.sent).toEqual([]);
    expect(broker.resets).toBe(2);
  });
});
