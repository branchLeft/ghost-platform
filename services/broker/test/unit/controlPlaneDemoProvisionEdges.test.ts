import { describe, expect, it } from 'vitest';
import type {
  DemoBroker,
  ReconcileReply,
  ResetReply,
  SlotReading,
} from '../../src/controlPlaneDemoBroker.js';
import {
  DemoRecordMissingError,
  provisionDemo,
  type LifecycleStore,
} from '../../src/controlPlaneDemoProvision.js';
import {
  DEMO_ID,
  SLOT,
  countingGate,
  depsFor,
  fakeStore,
  virtualClock,
} from '../helpers/demoProvisionRig.js';

// The step's own decisions, against a host that answers as scripted. The real
// broker proves the host side; these pin what the worker does with each answer.

function scripted(
  replies: {
    reconcile?: ReconcileReply[];
    status?: (SlotReading | undefined)[];
    reset?: ResetReply[];
  } = {}
): DemoBroker & { sent: number; resets: number } {
  const reconcile = [...(replies.reconcile ?? [{ kind: 'running', colour: 'a' }])];
  const status = [...(replies.status ?? [{ phase: 'running', healthy: true }])];
  const reset = [...(replies.reset ?? ['free'])];
  const broker = {
    sent: 0,
    resets: 0,
    async reconcile() {
      broker.sent += 1;
      return reconcile.length > 1 ? reconcile.shift()! : reconcile[0]!;
    },
    async status() {
      return status.length > 1 ? status.shift() : status[0];
    },
    async reset() {
      broker.resets += 1;
      return reset.length > 1 ? reset.shift()! : reset[0]!;
    },
  };
  return broker;
}

function run(broker: DemoBroker, store = fakeStore(() => 1_700_000_100_000)) {
  const clock = virtualClock();
  return {
    store,
    clock,
    result: provisionDemo(depsFor(store, broker, countingGate(), clock), DEMO_ID, SLOT),
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
    const { result } = run(broker);
    expect(await result).toMatchObject({
      state: 'FAILED',
      reason: 'broker-error',
      attempts: 2,
      slotNeedsAttention: true,
    });
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
});
