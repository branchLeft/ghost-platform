import { describe, expect, it } from 'vitest';
import type { BumpState, BumpStateMachine } from '../../src/bumpStateMachine.js';
import { assertGatesGreen } from '../../src/gates.js';
import { runRelease, type Release, type RingMember } from '../../src/ringController.js';
import {
  DEFAULT_BAKE_MS,
  DEFAULT_POLL_MS,
  MYSQL_CANARY_RING,
  MYSQL_GATED_RING,
  RING_ORDER,
  validateBakeConfig,
  type RingName,
} from '../../src/rings.js';
import {
  BAKE_MS,
  CLEAN_ENV,
  DIGEST,
  OLD_DIGEST,
  POLL_MS,
  RELEASE,
  bakeConfig,
  makeFleet,
} from './helpers/fakeFleet.js';

const run = (fleet: ReturnType<typeof makeFleet>, release: Release = RELEASE) =>
  runRelease(release, fleet.deps, bakeConfig(), CLEAN_ENV);

describe('the ring order', () => {
  it('is slot-0, demos, entry, professional, and cannot be changed', () => {
    expect([...RING_ORDER]).toEqual(['slot-0', 'demos', 'entry', 'professional']);
    expect(Object.isFrozen(RING_ORDER)).toBe(true);
    expect(() => (RING_ORDER as unknown as string[]).push('extra')).toThrow(TypeError);
  });

  it('bumps members ring by ring in that order and completes', async () => {
    const fleet = makeFleet();
    const outcome = await run(fleet);

    expect(outcome).toEqual({ status: 'completed' });
    expect(fleet.ringsInBumpOrder()).toEqual(['slot-0', 'demos', 'entry', 'professional']);
    expect(fleet.bumpOrder()).toEqual([
      'canary-mysql',
      'demo-1',
      'entry-1',
      'entry-2',
      'pro-1',
      'pro-2',
    ]);
    expect(fleet.holds).toEqual([]);
    expect(fleet.pages).toEqual([]);
  });

  it('stops every old colour only after its own ring has baked, ring by ring', async () => {
    const fleet = makeFleet();
    await run(fleet);

    expect(fleet.stoppedOld()).toEqual([
      'canary-mysql',
      'demo-1',
      'entry-1',
      'entry-2',
      'pro-1',
      'pro-2',
    ]);
    // Ring N+1 is not bumped until ring N is closed.
    const events = fleet.events;
    expect(events.indexOf('stop-old:canary-mysql')).toBeLessThan(events.indexOf('apply:demo-1'));
    expect(events.indexOf('stop-old:entry-2')).toBeLessThan(events.indexOf('apply:pro-1'));
  });
});

describe('serial within a ring', () => {
  it('never has two run() calls in flight at once', async () => {
    const fleet = makeFleet();
    await run(fleet);

    expect(fleet.counter.highWater).toBe(1);
  });
});

describe('the bake', () => {
  it('does not advance before the window has elapsed, and starts it at the last member done', async () => {
    const fleet = makeFleet({
      tenants: { 'entry-1': { applyTakesMs: 5_000 }, 'entry-2': { applyTakesMs: 7_000 } },
    });
    await run(fleet);

    const lastDone = fleet.doneAt.get('entry-2') as number;
    expect(fleet.closedAt.get('entry-1') as number).toBeGreaterThanOrEqual(lastDone + BAKE_MS);
    expect(fleet.closedAt.get('entry-2') as number).toBeGreaterThanOrEqual(lastDone + BAKE_MS);
    // Both members soak the full window, so the first one's own clock does not shorten it.
    const firstDone = fleet.doneAt.get('entry-1') as number;
    expect((fleet.closedAt.get('entry-1') as number) - firstDone).toBeGreaterThanOrEqual(
      BAKE_MS + 7_000
    );
  });

  it('polls every member on each pass and sleeps no longer than the time left', async () => {
    const fleet = makeFleet({ members: { demos: [], entry: [], professional: [] } });
    await runRelease(
      RELEASE,
      fleet.deps,
      bakeConfig({ 'slot-0': { bakeMs: 25_000, pollMs: 10_000 } }),
      CLEAN_ENV
    );

    // The slot-0 ring: 25s in 10s polls is 10, 10, 5.
    expect(fleet.sleeps.slice(0, 3)).toEqual([10_000, 10_000, 5_000]);
  });

  it('defaults the poll interval when a ring sets none', async () => {
    const fleet = makeFleet({ members: { demos: [], entry: [], professional: [] } });
    const config = {
      ...bakeConfig(),
      'slot-0': { bakeMs: DEFAULT_POLL_MS + 5_000 },
    };
    await runRelease(RELEASE, fleet.deps, config, CLEAN_ENV);

    expect(fleet.sleeps.slice(0, 2)).toEqual([DEFAULT_POLL_MS, 5_000]);
  });

  it('with a zero bake still reads every member once before advancing', async () => {
    const fleet = makeFleet();
    const zero = { bakeMs: 0 };
    const outcome = await runRelease(
      RELEASE,
      fleet.deps,
      { 'slot-0': zero, demos: zero, entry: zero, professional: zero },
      CLEAN_ENV
    );

    expect(outcome).toEqual({ status: 'completed' });
    expect(fleet.sleeps).toEqual([]);
    expect(fleet.calls.health).toBe(6);
  });

  it('bakes an empty ring for the full window, then moves on', async () => {
    const seen: Partial<Record<RingName, number>> = {};
    let fleet!: ReturnType<typeof makeFleet>;
    fleet = makeFleet({
      members: { demos: [] },
      listMembers: async (ring) => {
        seen[ring] = fleet.nowMs();
        return fleet.members[ring];
      },
    });

    const outcome = await run(fleet);

    expect(outcome).toEqual({ status: 'completed' });
    expect((seen.entry as number) - (seen.demos as number)).toBeGreaterThanOrEqual(BAKE_MS);
    expect(fleet.ringsInBumpOrder()).toEqual(['slot-0', 'entry', 'professional']);
  });
});

describe('the timer alone never advances a ring', () => {
  it('holds when the bake has elapsed and one tenant is silently unhealthy', async () => {
    const fleet = makeFleet({
      health: (tenantId) => ({ healthy: tenantId !== 'entry-2', reportedDigest: DIGEST }),
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'unhealthy',
      tenantId: 'entry-2',
    });
    expect(fleet.bumpOrder()).not.toContain('pro-1');
    expect(fleet.stoppedOld()).not.toContain('entry-1');
    expect(fleet.stoppedOld()).not.toContain('entry-2');
    expect(fleet.holds).toEqual([outcome]);
    expect(fleet.pages).toEqual([]);
  });

  it('holds when a tenant turns unhealthy only at the very end of the window', async () => {
    let fleet!: ReturnType<typeof makeFleet>;
    fleet = makeFleet({
      health: (tenantId, now) => ({
        healthy: !(
          tenantId === 'entry-1' && now >= (fleet.doneAt.get('entry-2') as number) + BAKE_MS
        ),
        reportedDigest: DIGEST,
      }),
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'unhealthy',
      tenantId: 'entry-1',
    });
  });

  it('holds when the bake has elapsed and a tenant has reported an error since the ring started', async () => {
    const sinceSeen: number[] = [];
    let fleet!: ReturnType<typeof makeFleet>;
    const ringStart: Partial<Record<RingName, number>> = {};
    fleet = makeFleet({
      listMembers: async (ring) => {
        ringStart[ring] = fleet.nowMs();
        return fleet.members[ring];
      },
      reportedErrors: (tenantId, since) => {
        if (tenantId === 'pro-2') sinceSeen.push(since);
        return tenantId === 'pro-2' ? ['unhandled exception in the theme'] : [];
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'professional',
      reason: 'reported-error',
      tenantId: 'pro-2',
    });
    expect(sinceSeen.every((since) => since === ringStart.professional)).toBe(true);
    expect(fleet.stoppedOld()).not.toContain('pro-1');
  });

  it('treats a healthy tenant still reporting the old digest as unhealthy', async () => {
    const fleet = makeFleet({
      health: (tenantId) => ({
        healthy: true,
        reportedDigest: tenantId === 'demo-1' ? OLD_DIGEST : DIGEST,
      }),
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'demos',
      reason: 'unhealthy',
      tenantId: 'demo-1',
    });
  });

  it('treats a healthy tenant reporting no digest at all as unhealthy', async () => {
    const fleet = makeFleet({ health: () => ({ healthy: true }) });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'slot-0', reason: 'unhealthy' });
  });

  it('blocks on a health probe that throws, and reverts nothing it cannot tell is wrong', async () => {
    const fleet = makeFleet({
      health: (tenantId) => {
        if (tenantId === 'entry-1') throw new Error('probe timed out');
        return { healthy: true, reportedDigest: DIGEST };
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'probe-failed',
      tenantId: 'entry-1',
    });
    expect(fleet.events.filter((e) => e.startsWith('revert:'))).toEqual([]);
    expect(fleet.stoppedOld()).not.toContain('entry-1');
  });

  it('blocks on an error probe that throws', async () => {
    const fleet = makeFleet({
      reportedErrors: () => {
        throw new Error('error feed down');
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'slot-0', reason: 'probe-failed' });
    expect(fleet.bumpOrder()).toEqual(['canary-mysql']);
  });

  it('reverts every regressed tenant by its own flag change and leaves the healthy ones open', async () => {
    const fleet = makeFleet({
      health: (tenantId) => ({ healthy: tenantId !== 'entry-2', reportedDigest: DIGEST }),
      reportedErrors: (tenantId) => (tenantId === 'entry-1' ? ['broken'] : []),
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'reported-error',
      tenantId: 'entry-1',
    });
    expect(fleet.events.filter((e) => e.startsWith('revert:'))).toEqual([
      'revert:entry-1',
      'revert:entry-2',
    ]);
    expect(fleet.machines.get('entry-1')?.getState()).toBe('reverted');
    expect(fleet.machines.get('entry-2')?.getState()).toBe('reverted');
    expect(fleet.machines.get('canary-mysql')?.getState()).toBe('closed');
    expect(fleet.stoppedOld()).not.toContain('entry-1');
  });

  it('holds only the first reason when a revert itself fails, and still reports the failure', async () => {
    const fleet = makeFleet({
      health: (tenantId) => ({ healthy: tenantId !== 'demo-1', reportedDigest: DIGEST }),
    });
    const original = fleet.deps.newBump;
    fleet.deps.newBump = (member, release) => {
      const machine = original(member, release);
      if (member.tenantId === 'demo-1') {
        machine.abortAfterDone = async () => {
          throw new Error('flag store unreachable');
        };
      }
      return machine;
    };
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'demos', reason: 'unhealthy' });
    expect(outcome.status === 'held' && outcome.detail).toContain(
      'revert failed: flag store unreachable'
    );
  });
});

describe('ring 0 and MySQL (U6)', () => {
  it('blocks entry to ring 2 when ring 0 is SQLite alone', async () => {
    const fleet = makeFleet({
      members: { 'slot-0': [{ tenantId: 'canary-sqlite', engine: 'sqlite' }] },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'entry', reason: 'no-mysql-in-ring-0' });
    expect(fleet.bumpOrder()).toEqual(['canary-sqlite', 'demo-1']);
  });

  it('blocks when ring 0 is empty, even with a MySQL tenant in ring 1', async () => {
    const fleet = makeFleet({
      members: { 'slot-0': [], demos: [{ tenantId: 'demo-mysql', engine: 'mysql' }] },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'entry', reason: 'no-mysql-in-ring-0' });
  });

  it('permits ring 2 with a healthy MySQL canary in ring 0', async () => {
    const fleet = makeFleet();
    const outcome = await run(fleet);

    expect(outcome).toEqual({ status: 'completed' });
    expect(fleet.bumpOrder()).toContain('entry-1');
  });

  it('names the ring-0 and ring-2 rings as constants', () => {
    expect(MYSQL_CANARY_RING).toBe(RING_ORDER[0]);
    expect(MYSQL_GATED_RING).toBe(RING_ORDER[2]);
  });

  it('never reaches ring 2 when the MySQL canary itself does not reach done', async () => {
    const fleet = makeFleet({ tenants: { 'canary-mysql': { applyOk: false } } });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'slot-0',
      reason: 'bump-not-done',
      tenantId: 'canary-mysql',
    });
    expect(fleet.bumpOrder()).toEqual(['canary-mysql']);
  });
});

describe('a bump that does not reach done', () => {
  it('stops the release and gives later members no run()', async () => {
    const fleet = makeFleet({ tenants: { 'entry-1': { applyOk: false } } });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'bump-not-done',
      tenantId: 'entry-1',
    });
    expect(fleet.calls.newBump).toBe(1 + 1 + 1); // canary, demo, entry-1; never entry-2
    expect(fleet.bumpOrder()).not.toContain('entry-2');
    expect(fleet.bumpOrder()).not.toContain('pro-1');
    // There is no fleet-wide undo: the members that did finish are left alone.
    expect(fleet.machines.get('canary-mysql')?.getState()).toBe('closed');
  });

  it('holds with bump-not-done when newBump or run() throws', async () => {
    const fleet = makeFleet();
    fleet.deps.newBump = () => {
      throw new Error('no wiring for this tenant');
    };
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'slot-0', reason: 'bump-not-done' });
    expect(outcome.status === 'held' && outcome.detail).toContain('no wiring for this tenant');
  });

  it('holds when closing a bake window throws or ends anywhere but closed', async () => {
    const stub = (closeResult: () => Promise<BumpState>): BumpStateMachine =>
      ({
        run: async () => 'done',
        closeBakeWindow: closeResult,
        abortAfterDone: async () => 'reverted',
      }) as unknown as BumpStateMachine;

    const throwing = makeFleet();
    throwing.deps.newBump = () =>
      stub(async () => {
        throw new Error('stop failed');
      });
    expect(await run(throwing)).toMatchObject({
      status: 'held',
      at: 'slot-0',
      reason: 'bump-not-done',
    });

    const stuck = makeFleet();
    stuck.deps.newBump = () => stub(async () => 'closing');
    const outcome = await run(stuck);
    expect(outcome).toMatchObject({ status: 'held', at: 'slot-0', reason: 'bump-not-done' });
    expect(outcome.status === 'held' && outcome.detail).toContain("'closing'");
  });

  it('holds with probe-failed when the members of a ring cannot be listed', async () => {
    const fleet = makeFleet({
      listMembers: async (ring) => {
        if (ring === 'entry') throw new Error('descriptor tier down');
        return fleet.members[ring];
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'entry', reason: 'probe-failed' });
    expect(fleet.bumpOrder()).not.toContain('entry-1');
  });
});

describe('the gates', () => {
  const greenFor = (digest: string) => ({ digest, results: [{ name: 'smoke', ok: true }] });

  it('run once, before any tenant, against the release digest', async () => {
    const fleet = makeFleet();
    await run(fleet);

    expect(fleet.calls.runGates).toBe(1);
    expect(fleet.events[0]).toBe('apply:canary-mysql');
  });

  it('bump nothing when any gate is red', async () => {
    const fleet = makeFleet({
      gates: (digest) => ({
        digest,
        results: [
          { name: 'smoke', ok: true },
          { name: 'migrations', ok: false },
        ],
      }),
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'gates', reason: 'gate-red' });
    expect(outcome.status === 'held' && outcome.detail).toContain('migrations');
    expect(fleet.calls.newBump).toBe(0);
    expect(fleet.pages).toEqual([]);
  });

  it('bump nothing when the gate list is empty', async () => {
    const fleet = makeFleet({ gates: (digest) => ({ digest, results: [] }) });

    expect(await run(fleet)).toMatchObject({ status: 'held', at: 'gates', reason: 'gate-red' });
    expect(fleet.calls.newBump).toBe(0);
  });

  it('bump nothing when the report is for another digest, however green', async () => {
    const fleet = makeFleet({ gates: () => greenFor(OLD_DIGEST) });

    expect(await run(fleet)).toMatchObject({
      status: 'held',
      at: 'gates',
      reason: 'gate-digest-mismatch',
    });
    expect(fleet.calls.newBump).toBe(0);
  });

  it('bump nothing when the gates cannot be run at all', async () => {
    const fleet = makeFleet({ runGatesThrows: true });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', at: 'gates', reason: 'gate-red' });
    expect(outcome.status === 'held' && outcome.detail).toContain('gate host unreachable');
    expect(fleet.calls.newBump).toBe(0);
  });

  it('assertGatesGreen treats a blank release digest as a mismatch', () => {
    expect(
      assertGatesGreen({ digest: '', results: [{ name: 'a', ok: true }] }, { digest: '' })
    ).toMatchObject({
      ok: false,
      reason: 'gate-digest-mismatch',
    });
    expect(assertGatesGreen(greenFor('x'), { digest: 'x' })).toEqual({ ok: true });
  });
});

describe('the consent route', () => {
  it('runs no gate and bumps no tenant for a major or irreversible release', async () => {
    const fleet = makeFleet();
    const outcome = await run(fleet, { ...RELEASE, route: 'consent' });

    expect(outcome).toMatchObject({ status: 'held', at: 'preflight', reason: 'consent-required' });
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
    expect(fleet.pages).toEqual([]);
  });
});

describe('the hold sink', () => {
  it('receives the same record the caller gets, naming the release', async () => {
    const fleet = makeFleet({ tenants: { 'demo-1': { applyOk: false } } });
    const outcome = await run(fleet);

    expect(fleet.holds).toEqual([outcome]);
    expect(outcome).toMatchObject({ digest: DIGEST, version: '1.2.3', tenantId: 'demo-1' });
  });
});

describe('config and environment', () => {
  const badConfigs: [string, unknown][] = [
    ['a ring with no bake at all', { ...bakeConfig(), demos: undefined }],
    ['a negative bakeMs', { ...bakeConfig(), entry: { bakeMs: -1 } }],
    ['a bakeMs that is not a number', { ...bakeConfig(), entry: { bakeMs: Number.NaN } }],
    ['a pollMs of zero', { ...bakeConfig(), entry: { bakeMs: 1, pollMs: 0 } }],
  ];

  it.each(badConfigs)('refuses %s before touching anything', async (_name, config) => {
    const fleet = makeFleet();

    await expect(
      runRelease(RELEASE, fleet.deps, config as never, CLEAN_ENV)
    ).rejects.toBeInstanceOf(RangeError);
    expect(fleet.calls.runGates).toBe(0);
    expect(() => validateBakeConfig(config as never)).toThrow(RangeError);
  });

  it('refuses a model key in env before running a gate', async () => {
    const fleet = makeFleet();

    await expect(
      runRelease(RELEASE, fleet.deps, bakeConfig(), { ANTHROPIC_API_KEY: 'sk-not-a-real-key' })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
  });

  it('carries the incidental default bake times', () => {
    const minutes = (ms: number) => ms / 60_000;
    expect(RING_ORDER.map((ring) => minutes(DEFAULT_BAKE_MS[ring]))).toEqual([15, 15, 30, 30]);
    expect(POLL_MS).toBeLessThan(BAKE_MS);
  });
});

describe('members are plain data', () => {
  it('works for any engine mix', async () => {
    const members: RingMember[] = [
      { tenantId: 'a', engine: 'mysql' },
      { tenantId: 'b', engine: 'sqlite' },
    ];
    const fleet = makeFleet({ members: { 'slot-0': members } });

    expect(await run(fleet)).toEqual({ status: 'completed' });
    expect(fleet.bumpOrder().slice(0, 2)).toEqual(['a', 'b']);
  });
});
