import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { DemoBroker } from '../../src/controlPlaneDemoBroker.js';
import {
  DemoNotClaimedError,
  provisionDemo,
  type ProvisionDeps,
} from '../../src/controlPlaneDemoProvision.js';
import { descriptorForSlot } from '../helpers/fixtures.js';
import {
  DEMO_ID,
  LEASE_MS,
  OWNER,
  SLOT,
  controllableHealth,
  countingGate,
  depsFor,
  fakeStore,
  recordingMailer,
  tunnelTo,
  virtualClock,
  type ControllableHealth,
} from '../helpers/demoProvisionRig.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

// The real broker, in process, behind the real signed-request check: the
// worker's calls are signed and verified, not stubbed. What is stood in is the
// host's Ghost, the sidecar's health answer and the database.

let broker: TestBroker | undefined;
let health: ControllableHealth;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

async function started(): Promise<TestBroker> {
  health = controllableHealth();
  broker = await startTestBroker({ wrapDeps: (deps) => ({ ...deps, healthChecker: health }) });
  return broker;
}

async function wrapperVerbs(b: TestBroker): Promise<string[]> {
  const text = await readFile(b.wrapperLogPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as string[]).at(-1) as string);
}

function setup(b: TestBroker, wrap: (inner: DemoBroker) => DemoBroker = (inner) => inner) {
  const clock = virtualClock();
  const store = fakeStore(clock.nowMs);
  const gate = countingGate();
  const logs: string[] = [];
  const mailer = recordingMailer();
  /** The demo's state at the moment each arrival mail went: it must not be LIVE yet. */
  const stateAtMail: string[] = [];
  const deps: ProvisionDeps = depsFor(store, wrap(tunnelTo(b)), gate, clock, logs, async (a) => {
    stateAtMail.push(store.state());
    await mailer.send(a);
  });
  return { clock, store, gate, logs, deps, mailer, stateAtMail };
}

async function statusOf(
  b: TestBroker,
  slot: SlotName
): Promise<{ phase: string; healthy: boolean }> {
  const response = await fetch(`${b.baseUrl}/status/${slot}`);
  return (await response.json()) as { phase: string; healthy: boolean };
}

describe('provisionDemo against the real broker', () => {
  it('a request becomes a running slot: PROVISIONING issues the seven-day term, the descriptor expires with it, LIVE follows a healthy answer', async () => {
    const b = await started();
    const { store, deps, gate, mailer, stateAtMail } = setup(b);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome.state).toBe('LIVE');
    if (outcome.state !== 'LIVE') return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.colour).toBe('a');
    // The passphrase leaves only in the arrival mail, and the mail goes before LIVE.
    expect(outcome).not.toHaveProperty('passphrase');
    expect(mailer.sent).toEqual([
      {
        address: OWNER,
        hostname: outcome.hostname,
        passphrase: gate.issued[0],
        expiresAt: outcome.expiresAt,
      },
    ]);
    expect(stateAtMail).toEqual(['PROVISIONING']);
    expect(store.moves).toEqual(['PROVISIONING', 'LIVE']);
    expect(await statusOf(b, SLOT)).toMatchObject({ phase: 'running', healthy: true });

    // The descriptor the host rendered carries the owner, the hostname from
    // the register and an expiry exactly seven days on from the term's start.
    expect(b.renderer.calls).toHaveLength(1);
    const rendered = b.renderer.calls[0]!;
    expect(rendered.ownerEmail).toBe(OWNER);
    expect(rendered.hostname).toEqual({ kind: 'ours', sub: outcome.hostname, gated: true });
    expect(Date.parse(rendered.expiresAt as string)).toBe(outcome.expiresAt.getTime());
    expect(outcome.expiresAt.getTime()).toBe(1_700_000_100_000 + LEASE_MS);
  });

  it('is not LIVE on the reconcile answer alone: it waits out an unhealthy colour, then goes LIVE only on the healthy answer', async () => {
    const b = await started();
    health.script([false, false, false, true]);
    const { store, deps, clock } = setup(b);
    const started0 = clock.nowMs();

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome.state).toBe('LIVE');
    // Three unhealthy answers were read and slept through before the fourth.
    expect(clock.nowMs() - started0).toBe(3000);
    expect(health.calls).toBe(4);
    expect(store.moves).toEqual(['PROVISIONING', 'LIVE']);
  });

  it('control case: a reconcile whose answer is lost is sent again unchanged and creates no second demo', async () => {
    const b = await started();
    let dropped = 0;
    const lossy: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/reconcile') && dropped === 0) {
        dropped += 1;
        // The host did the work; the answer never arrived.
        throw new DOMException('timed out', 'TimeoutError');
      }
      return response;
    };
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs);
    const deps = depsFor(store, tunnelTo(b, { fetch: lossy }), countingGate(), clock);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(dropped).toBe(1);
    expect(outcome.state).toBe('LIVE');
    if (outcome.state === 'LIVE') expect(outcome.attempts).toBe(1);
    // One start, one render: the second send was recognised as the same descriptor.
    expect((await wrapperVerbs(b)).filter((verb) => verb === 'start')).toHaveLength(1);
    expect(b.renderer.calls).toHaveLength(1);
  });

  it('control case: a different descriptor for an occupied slot is refused, the occupant is untouched, and nothing is reset', async () => {
    const b = await started();
    // Another tenancy already holds slot 1.
    const occupant = descriptorForSlot(SLOT, {
      hostname: { kind: 'ours', sub: 'someone-elses-demo', gated: true },
      siteUrl: 'https://someone-elses-demo.demo-domain.example.test' as never,
    });
    const first = await b.signedFetch('POST', '/reconcile', { slot: SLOT, descriptor: occupant });
    expect(first.status).toBe(200);
    const before = (await wrapperVerbs(b)).length;

    const { store, deps, logs } = setup(b);
    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({
      state: 'FAILED',
      reason: 'refused',
      attempts: 1,
      slotNeedsAttention: false,
      hostnameRetired: true,
    });
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
    // The occupant still runs, and the worker sent no reset and no start.
    expect(await statusOf(b, SLOT)).toMatchObject({ phase: 'running' });
    expect(await wrapperVerbs(b)).toHaveLength(before);
    expect(logs.join('\n')).toContain('refused (409)');
  });

  it("kill the slot's Ghost mid-provision: one retry after a full reset with a fresh passphrase, then FAILED, never a wait with no end", async () => {
    const b = await started();
    // The host accepts the reconcile and starts a Ghost; it never answers healthy.
    health.script([false]);
    const { store, deps, gate, clock } = setup(b);
    const began = clock.nowMs();

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({
      state: 'FAILED',
      reason: 'unhealthy',
      attempts: 2,
      slotNeedsAttention: false,
      hostnameRetired: true,
    });
    expect(store.state()).toBe('FAILED');
    expect(store.moves).toEqual(['PROVISIONING', 'FAILED']);
    expect(store.retired).toEqual([outcome.state === 'FAILED' ? outcome.hostname : '']);
    // Two attempts, each with its own passphrase and therefore its own descriptor.
    expect(gate.issued).toEqual(['pass-1', 'pass-2']);
    expect(b.renderer.calls).toHaveLength(2);
    expect(b.renderer.calls[0]!.gate).not.toEqual(b.renderer.calls[1]!.gate);
    // Reset between the two attempts and again after the last: it ends free.
    const verbs = await wrapperVerbs(b);
    expect(verbs.filter((verb) => verb === 'start')).toHaveLength(2);
    expect(verbs.filter((verb) => verb === 'reset')).toHaveLength(2);
    expect(await statusOf(b, SLOT)).toMatchObject({ phase: 'free' });
    // Bounded: two polls of the timeout at most, on the virtual clock.
    expect(clock.nowMs() - began).toBeLessThanOrEqual(2 * 31_000);
  });

  it('a host fault on the first attempt is retried once and goes LIVE; the retry is the second attempt', async () => {
    const b = await started();
    b.adminApi.fail = true;
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs);
    const gate = countingGate();
    const inner = tunnelTo(b);
    const healing: DemoBroker = {
      ...inner,
      async reset(slot) {
        // The fault clears between the attempts.
        b.adminApi.fail = false;
        return inner.reset(slot);
      },
    };
    const deps = depsFor(store, healing, gate, clock);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome.state).toBe('LIVE');
    if (outcome.state === 'LIVE') expect(outcome.attempts).toBe(2);
    expect(gate.issued).toHaveLength(2);
    expect(store.moves).toEqual(['PROVISIONING', 'LIVE']);
    expect(await statusOf(b, SLOT)).toMatchObject({ phase: 'running', healthy: true });
  });

  it('a host fault on both attempts ends in FAILED with the broker-error reason and the slot freed', async () => {
    const b = await started();
    b.adminApi.fail = true;
    const { store, deps } = setup(b);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'broker-error', attempts: 2 });
    expect(store.state()).toBe('FAILED');
    expect(await statusOf(b, SLOT)).toMatchObject({ phase: 'free' });
  });

  it('a signature the broker does not accept is a refusal, not a retry', async () => {
    const b = await started();
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs);
    const wrongKey = tunnelTo(b);
    const deaf: DemoBroker = {
      ...wrongKey,
      reconcile: async () => ({ kind: 'refused', status: 401 }),
    };
    const deps = depsFor(store, deaf, countingGate(), clock);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({ state: 'FAILED', reason: 'refused', attempts: 1 });
  });

  it('refuses a demo that is not CLAIMED before sending anything', async () => {
    const b = await started();
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs, 'LIVE');
    const deps = depsFor(store, tunnelTo(b), countingGate(), clock);

    await expect(provisionDemo(deps, DEMO_ID, SLOT)).rejects.toBeInstanceOf(DemoNotClaimedError);
    expect(store.moves).toEqual([]);
    expect(b.renderer.calls).toHaveLength(0);
  });

  it('a failed demo still ends FAILED when the register will not take the retirement, and says so', async () => {
    const b = await started();
    health.script([false]);
    const { store, deps } = setup(b);
    store.failRetire = true;

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({ state: 'FAILED', hostnameRetired: false });
    expect(store.state()).toBe('FAILED');
  });

  it('a slot that will not reset between attempts is not retried into: FAILED and flagged for a person', async () => {
    const b = await started();
    b.adminApi.fail = true;
    const clock = virtualClock();
    const store = fakeStore(clock.nowMs);
    const inner = tunnelTo(b);
    const stuck: DemoBroker = { ...inner, reset: async () => 'refused' };
    const deps = depsFor(store, stuck, countingGate(), clock);

    const outcome = await provisionDemo(deps, DEMO_ID, SLOT);

    expect(outcome).toMatchObject({
      state: 'FAILED',
      reason: 'reset-failed',
      attempts: 1,
      slotNeedsAttention: true,
    });
  });
});
