import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrentTransitionError,
  DEMO_STATES,
  DemoExistsError,
  ExtensionRefusedError,
  ForbiddenTransitionError,
  InvalidDemoIdError,
  UnknownDemoError,
  isAllowedTransition,
  type DemoState,
  type DemoEventView,
} from '../src/demoLifecycle.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { demoStateEvent } from '../src/schema.js';
import {
  databaseClock,
  endShiftSeconds,
  refusal,
  secondsBetween,
  storedEventRows,
  storedRegisterRows,
  waitForLockWait,
  type StoredEvent,
} from './demoHelpers.js';
import { createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let provisioner: ProvisionerDb;

beforeAll(async () => {
  fx = await createFixture();
  provisioner = new ProvisionerDb(fx.provisioner);
}, 60000);

afterAll(async () => {
  await fx.close();
});

/** The path from VERIFIED to each state, as transitions in order; EXTENDED is reached by `extend`. */
const PATH: Record<DemoState, readonly DemoState[]> = {
  VERIFIED: [],
  WAITING: ['WAITING'],
  CLAIMED: ['CLAIMED'],
  PROVISIONING: ['CLAIMED', 'PROVISIONING'],
  LIVE: ['CLAIMED', 'PROVISIONING', 'LIVE'],
  EXTENDED: ['CLAIMED', 'PROVISIONING', 'LIVE', 'EXTENDED'],
  EXPIRING: ['CLAIMED', 'PROVISIONING', 'LIVE', 'EXPIRING'],
  REBUILDING: ['CLAIMED', 'PROVISIONING', 'LIVE', 'REBUILDING'],
  PROMOTING: ['CLAIMED', 'PROVISIONING', 'LIVE', 'PROMOTING'],
  PROMOTED: ['CLAIMED', 'PROVISIONING', 'LIVE', 'PROMOTING', 'PROMOTED'],
  FAILED: ['CLAIMED', 'PROVISIONING', 'FAILED'],
  KILLED: ['CLAIMED', 'KILLED'],
  FROZEN: ['CLAIMED', 'FROZEN'],
  PURGED: ['CLAIMED', 'PROVISIONING', 'LIVE', 'EXPIRING', 'PURGED'],
};

/** Moves a new demo along `steps`, using `extend` for the move into EXTENDED from LIVE or EXPIRING. */
async function walk(steps: readonly DemoState[], demoId = randomUUID()): Promise<string> {
  await provisioner.beginDemo(demoId);
  let state: DemoState = 'VERIFIED';
  for (const step of steps) {
    if (step === 'EXTENDED' && state !== 'PROMOTING') await provisioner.extend(demoId);
    else await provisioner.transition(demoId, step);
    state = step;
  }
  return demoId;
}

async function reachedState(demoId: string): Promise<DemoState | undefined> {
  return (await provisioner.currentState(demoId))?.toState;
}

const storedRows = (demoId: string): ReturnType<typeof storedEventRows> =>
  storedEventRows(fx.adminDb, demoId);

/** Plants a row as the administrator, bypassing the operations, to see what the table itself refuses. */
const plant = (values: typeof demoStateEvent.$inferInsert): Promise<unknown> =>
  fx.adminDb
    .insert(demoStateEvent)
    .values(values)
    .then(() => undefined);

const at = (iso: string): Date => new Date(iso);
const HOUR = 3600 * 1000;

describe('a demo moves through every state', () => {
  it('walks VERIFIED, CLAIMED, PROVISIONING, LIVE, EXPIRING, PURGED, keeping each transition as a row', async () => {
    const demoId = await walk(PATH.PURGED);
    const history = await provisioner.history(demoId);
    expect(history.map((event) => event.toState)).toEqual([
      'VERIFIED',
      'CLAIMED',
      'PROVISIONING',
      'LIVE',
      'EXPIRING',
      'PURGED',
    ]);
    expect(history.map((event) => event.fromState)).toEqual([
      null,
      'VERIFIED',
      'CLAIMED',
      'PROVISIONING',
      'LIVE',
      'EXPIRING',
    ]);
    expect(history.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    const times = history.map((event) => event.recordedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // The term is on every row from PROVISIONING on, and on none before it.
    expect(history.map((event) => event.leaseEndsAt !== null)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it('records no person: the history row holds the transition, its time and the term, nothing else', async () => {
    const demoId = await walk(PATH.LIVE);
    const [row] = await storedRows(demoId);
    expect(Object.keys(row!).sort()).toEqual([
      'demo_id',
      'extension_days',
      'from_state',
      'lease_ends_at',
      'lease_issued_at',
      'previous_sequence',
      'recorded_at',
      'sequence',
      'to_state',
    ]);
  });

  it('puts a demo in WAITING when no slot is free, then CLAIMED when one frees', async () => {
    const demoId = await walk(['WAITING', 'CLAIMED']);
    expect((await provisioner.history(demoId)).map((e) => e.toState)).toEqual([
      'VERIFIED',
      'WAITING',
      'CLAIMED',
    ]);
  });

  it('returns a claim that timed out to WAITING', async () => {
    const demoId = await walk(['CLAIMED', 'WAITING', 'CLAIMED']);
    expect(await reachedState(demoId)).toBe('CLAIMED');
  });

  it('moves LIVE to EXTENDED and on to EXPIRING, PROMOTING and PURGED paths', async () => {
    const demoId = await walk(['CLAIMED', 'PROVISIONING', 'LIVE', 'EXTENDED', 'EXPIRING']);
    expect(await reachedState(demoId)).toBe('EXPIRING');
    const promoted = await walk([...PATH.EXTENDED, 'PROMOTING', 'PROMOTED']);
    expect(await reachedState(promoted)).toBe('PROMOTED');
  });

  it('moves a rebuilding demo back to LIVE, or on to FAILED', async () => {
    expect(await reachedState(await walk([...PATH.REBUILDING, 'LIVE']))).toBe('LIVE');
    expect(await reachedState(await walk([...PATH.REBUILDING, 'FAILED']))).toBe('FAILED');
  });

  it('takes a promotion that does not complete back to the state it came from', async () => {
    for (const origin of ['LIVE', 'EXTENDED', 'EXPIRING'] as const) {
      const demoId = await walk([...PATH[origin], 'PROMOTING']);
      const returned = await provisioner.transition(demoId, origin);
      expect(returned.toState).toBe(origin);
    }
  });

  it('refuses a promotion that returns anywhere but where it came from', async () => {
    const demoId = await walk([...PATH.LIVE, 'PROMOTING']);
    await expect(provisioner.transition(demoId, 'EXPIRING')).rejects.toThrow(
      ForbiddenTransitionError
    );
    expect(await reachedState(demoId)).toBe('PROMOTING');
  });

  it.each(['FAILED', 'KILLED', 'FROZEN', 'PROMOTED', 'PURGED'] as const)(
    'ends in %s with no way out',
    async (terminal) => {
      const demoId = await walk(PATH[terminal]);
      expect(await reachedState(demoId)).toBe(terminal);
      for (const to of DEMO_STATES) {
        await expect(provisioner.transition(demoId, to)).rejects.toThrow(ForbiddenTransitionError);
      }
    }
  );

  it.each([
    'CLAIMED',
    'PROVISIONING',
    'LIVE',
    'EXTENDED',
    'EXPIRING',
    'REBUILDING',
    'PROMOTING',
  ] as const)('lets the kill switch and the content flag leave %s', async (state) => {
    expect(await reachedState(await walkThen(state, 'KILLED'))).toBe('KILLED');
    expect(await reachedState(await walkThen(state, 'FROZEN'))).toBe('FROZEN');
  });

  async function walkThen(state: DemoState, to: DemoState): Promise<string> {
    const demoId = await walk(PATH[state]);
    await provisioner.transition(demoId, to);
    return demoId;
  }

  it('refuses a demo that was never begun, and one begun twice', async () => {
    await expect(provisioner.transition(randomUUID(), 'CLAIMED')).rejects.toThrow(UnknownDemoError);
    await expect(provisioner.extend(randomUUID())).rejects.toThrow(UnknownDemoError);
    const demoId = await walk([]);
    await expect(provisioner.beginDemo(demoId)).rejects.toThrow(DemoExistsError);
    await expect(provisioner.beginDemo('not-a-uuid')).rejects.toThrow(InvalidDemoIdError);
    expect(await provisioner.currentState(randomUUID())).toBeUndefined();
  });
});

describe('every ordered pair of states, through the operation, against the database', () => {
  const pairs = DEMO_STATES.flatMap((from) => DEMO_STATES.map((to) => [from, to] as const));

  /** A demo in `from`; for PROMOTING, one that came from `to`, so a return is the move under test. */
  async function demoAt(from: DemoState, to: DemoState): Promise<string> {
    if (from !== 'PROMOTING') return walk(PATH[from]);
    const origin = to === 'LIVE' || to === 'EXTENDED' || to === 'EXPIRING' ? to : 'LIVE';
    return walk([...PATH[origin], 'PROMOTING']);
  }

  it.each(pairs)(
    '%s to %s',
    async (from, to) => {
      const demoId = await demoAt(from, to);
      const move = (): Promise<DemoEventView> =>
        to === 'EXTENDED' && from !== 'PROMOTING'
          ? provisioner.extend(demoId)
          : provisioner.transition(demoId, to);
      if (isAllowedTransition(from, to)) {
        const event = await move();
        expect([event.fromState, event.toState]).toEqual([from, to]);
      } else {
        const refusal =
          to === 'EXTENDED' && from !== 'PROMOTING'
            ? ExtensionRefusedError
            : ForbiddenTransitionError;
        await expect(move()).rejects.toThrow(refusal);
        expect(await reachedState(demoId)).toBe(from);
      }
    },
    30000
  );
});

describe('the lease: seven days from the database clock, on entry to PROVISIONING', () => {
  it('stores an end exactly seven days after the issue time, from the database clock', async () => {
    const demoId = await walk(['CLAIMED']);
    const before = await databaseClock(fx.adminDb);
    const event = await provisioner.transition(demoId, 'PROVISIONING');
    const after = await databaseClock(fx.adminDb);
    expect(event.leaseIssuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(event.leaseIssuedAt!.getTime()).toBeLessThanOrEqual(after);
    const row = (await storedRows(demoId)).at(-1)!;
    expect(row.to_state).toBe('PROVISIONING');
    expect(
      await secondsBetween(
        fx.adminDb,
        demoId,
        3,
        demoStateEvent.leaseIssuedAt,
        demoStateEvent.leaseEndsAt
      )
    ).toBe(7 * 24 * 3600);
    expect(row.lease_issued_at).toBe(row.recorded_at);
  });

  it('is issued by PROVISIONING and not before: no term while VERIFIED, WAITING or CLAIMED', async () => {
    const demoId = await walk(['WAITING', 'CLAIMED']);
    for (const event of await provisioner.history(demoId)) {
      expect([event.leaseIssuedAt, event.leaseEndsAt]).toEqual([null, null]);
    }
  });

  it('ignores a time the caller passes: a call cannot backdate or pre-date the term', async () => {
    const past = new Date('2001-01-01T00:00:00Z');
    const demoId = await walk(['CLAIMED']);
    // @ts-expect-error the operation takes no time; a third argument must change nothing
    const event = await provisioner.transition(demoId, 'PROVISIONING', { issuedAt: past });
    expect(event.leaseIssuedAt!.getFullYear()).toBeGreaterThan(2020);
    expect(event.leaseIssuedAt!.getTime()).toBe(event.recordedAt.getTime());
  });

  it('refuses at the table a term that is not seven days, or that does not start at the row time', async () => {
    const demoId = await walk(['CLAIMED']);
    const start = at('2030-01-08T00:00:00Z');
    const provisioning = (issued: Date, ends: Date): Promise<unknown> =>
      plant({
        demoId,
        sequence: 3,
        previousSequence: 2,
        fromState: 'CLAIMED',
        toState: 'PROVISIONING',
        leaseIssuedAt: issued,
        leaseEndsAt: ends,
        recordedAt: start,
      });
    expect(
      await refusal(provisioning(start, new Date(start.getTime() + 144 * HOUR)))
    ).toMatchObject({
      constraint: 'demo_state_event_term_set',
    });
    const earlier = new Date(start.getTime() - 38 * 24 * HOUR);
    expect(
      await refusal(provisioning(earlier, new Date(earlier.getTime() + 168 * HOUR)))
    ).toMatchObject({
      constraint: 'demo_state_event_term_set',
    });
    expect(
      await refusal(provisioning(start, new Date(start.getTime() + 168 * HOUR)))
    ).toBeUndefined();
  });

  it('never has a null end from PROVISIONING on', async () => {
    const demoId = await walk(['CLAIMED']);
    expect(
      await refusal(
        plant({
          demoId,
          sequence: 3,
          previousSequence: 2,
          fromState: 'CLAIMED',
          toState: 'PROVISIONING',
        })
      )
    ).toMatchObject({ constraint: 'demo_state_event_lease_by_state' });
    expect(
      await refusal(
        plant({
          demoId,
          sequence: 3,
          previousSequence: 2,
          fromState: 'CLAIMED',
          toState: 'KILLED',
          leaseIssuedAt: new Date(),
        })
      )
    ).toMatchObject({ constraint: 'demo_state_event_lease_complete' });
  });

  it('refuses at the table a term whose end is not after its start, and a term before PROVISIONING', async () => {
    const demoId = await walk(['CLAIMED', 'PROVISIONING']);
    expect(
      await refusal(
        plant({
          demoId,
          sequence: 4,
          previousSequence: 3,
          fromState: 'PROVISIONING',
          toState: 'LIVE',
          leaseIssuedAt: at('2030-01-08T00:00:00Z'),
          leaseEndsAt: at('2030-01-01T00:00:00Z'),
        })
      )
    ).toMatchObject({ constraint: 'demo_state_event_lease_finite' });
    const issued = new Date();
    const ends = new Date(issued.getTime() + 24 * HOUR);
    const early = await walk(['CLAIMED']);
    expect(
      await refusal(
        plant({
          demoId: early,
          sequence: 3,
          previousSequence: 2,
          fromState: 'CLAIMED',
          toState: 'KILLED',
          leaseIssuedAt: issued,
          leaseEndsAt: ends,
        })
      )
    ).toBeUndefined();
    const waiting = await walk(['CLAIMED']);
    expect(
      await refusal(
        plant({
          demoId: waiting,
          sequence: 3,
          previousSequence: 2,
          fromState: 'CLAIMED',
          toState: 'WAITING',
          leaseIssuedAt: issued,
          leaseEndsAt: ends,
        })
      )
    ).toMatchObject({ constraint: 'demo_state_event_lease_by_state' });
  });
});

describe('the extension: the end moves by 14 days and nothing else', () => {
  it('adds 14 days to the end of the term, leaving the issue time and every earlier row as they were', async () => {
    const demoId = await walk(['CLAIMED']);
    await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'PROVISIONING');
    await provisioner.transition(demoId, 'LIVE');
    const before = await storedRows(demoId);
    const registerBefore = await storedRegisterRows(fx.adminDb, demoId);
    const event = await provisioner.extend(demoId);
    const after = await storedRows(demoId);
    expect(after).toHaveLength(before.length + 1);
    // Every earlier row is byte for byte the same.
    expect(after.slice(0, before.length)).toEqual(before);
    // The new row differs from the one before it in the transition and the end alone.
    const strip = (row: StoredEvent): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...row };
      for (const key of [
        'sequence',
        'previous_sequence',
        'from_state',
        'to_state',
        'lease_ends_at',
        'extension_days',
        'recorded_at',
      ]) {
        delete copy[key];
      }
      return copy;
    };
    expect(strip(after.at(-1)!)).toEqual(strip(before.at(-1)!));
    expect(after.at(-1)).toMatchObject({
      to_state: 'EXTENDED',
      from_state: 'LIVE',
      extension_days: 14,
    });
    expect(await endShiftSeconds(fx.adminDb, demoId, before.length, before.length + 1)).toBe(
      14 * 24 * 3600
    );
    expect(event.toState).toBe('EXTENDED');
    // The register row is untouched.
    expect(registerBefore).toHaveLength(1);
    expect(await storedRegisterRows(fx.adminDb, demoId)).toEqual(registerBefore);
  });

  it('keeps the hostname through an extension', async () => {
    const demoId = await walk(['CLAIMED']);
    const label = await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'PROVISIONING');
    await provisioner.transition(demoId, 'LIVE');
    await provisioner.extend(demoId);
    expect(await provisioner.hostname(demoId)).toBe(label);
  });

  it('extends from EXPIRING as well, to EXTENDED', async () => {
    const demoId = await walk(PATH.EXPIRING);
    const event = await provisioner.extend(demoId);
    expect([event.fromState, event.toState, event.extensionDays]).toEqual([
      'EXPIRING',
      'EXTENDED',
      14,
    ]);
  });

  it('refuses a second self-service extension for the same demo', async () => {
    const demoId = await walk(PATH.EXTENDED);
    await provisioner.transition(demoId, 'EXPIRING');
    await expect(provisioner.extend(demoId)).rejects.toThrow(
      'has used its one self-service extension'
    );
    const refused = await provisioner.extend(demoId).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExtensionRefusedError);
    expect((refused as ExtensionRefusedError).reason).toBe('spent');
    expect(await reachedState(demoId)).toBe('EXPIRING');
  });

  it.each(DEMO_STATES.filter((state) => state !== 'LIVE' && state !== 'EXPIRING'))(
    'refuses an extension of a demo that is %s',
    async (state) => {
      const demoId = await walk(PATH[state]);
      const refused = await provisioner.extend(demoId).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ExtensionRefusedError);
      expect((refused as ExtensionRefusedError).reason).toBe('state');
    }
  );

  it('leaves the term at its own end when a demo is only moved to EXPIRING', async () => {
    const demoId = await walk(PATH.LIVE);
    const live = (await provisioner.currentState(demoId))!;
    const expiring = await provisioner.transition(demoId, 'EXPIRING');
    expect(expiring.leaseEndsAt).toEqual(live.leaseEndsAt);
    expect(expiring.leaseIssuedAt).toEqual(live.leaseIssuedAt);
  });

  it('refuses at the table an extension amount on any row but EXTENDED, or a negative one', async () => {
    const demoId = await walk(PATH.LIVE);
    const live = (await provisioner.currentState(demoId))!;
    const expiring = {
      demoId,
      sequence: 5,
      previousSequence: 4,
      fromState: 'LIVE',
      toState: 'EXPIRING',
      leaseIssuedAt: live.leaseIssuedAt,
      leaseEndsAt: live.leaseEndsAt,
    };
    expect(await refusal(plant({ ...expiring, extensionDays: 14 }))).toMatchObject({
      constraint: 'demo_state_event_extension_only_extended',
    });
    expect(await refusal(plant({ ...expiring, extensionDays: -1 }))).toMatchObject({
      constraint: 'demo_state_event_extension_only_extended',
    });
  });
});

describe('a rebuild keeps the term', () => {
  it('stores the same issue time and end on the rebuilt LIVE row, to the microsecond, and is no extension', async () => {
    const demoId = await walk(PATH.LIVE);
    await provisioner.transition(demoId, 'REBUILDING');
    await provisioner.transition(demoId, 'LIVE');
    const rows = await storedRows(demoId);
    const [live, rebuilding, rebuilt] = [rows[3]!, rows[4]!, rows[5]!];
    expect(rebuilding.lease_ends_at).toBe(live.lease_ends_at);
    expect(rebuilt.lease_ends_at).toBe(live.lease_ends_at);
    expect(rebuilt.lease_issued_at).toBe(live.lease_issued_at);
    expect(rebuilt.extension_days).toBe(0);
    expect(rebuilt.recorded_at).not.toBe(live.recorded_at);
  });

  it('on day six still ends on day seven', async () => {
    const demoId = randomUUID();
    const issued = new Date(Date.now() - 6 * 24 * HOUR);
    const ends = new Date(issued.getTime() + 168 * HOUR);
    await plant({ demoId, sequence: 1, toState: 'VERIFIED' });
    await plant({
      demoId,
      sequence: 2,
      previousSequence: 1,
      fromState: 'VERIFIED',
      toState: 'CLAIMED',
    });
    await plant({
      demoId,
      sequence: 3,
      previousSequence: 2,
      fromState: 'CLAIMED',
      toState: 'PROVISIONING',
      leaseIssuedAt: issued,
      leaseEndsAt: ends,
      recordedAt: issued,
    });
    await plant({
      demoId,
      sequence: 4,
      previousSequence: 3,
      fromState: 'PROVISIONING',
      toState: 'LIVE',
      leaseIssuedAt: issued,
      leaseEndsAt: ends,
    });
    const before = (await storedRows(demoId)).at(-1)!;
    await provisioner.transition(demoId, 'REBUILDING');
    const rebuilt = await provisioner.transition(demoId, 'LIVE');
    const after = (await storedRows(demoId)).at(-1)!;
    expect(after.lease_ends_at).toBe(before.lease_ends_at);
    const remaining = rebuilt.leaseEndsAt!.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(24 * HOUR);
  });

  it('keeps an extended end through a promotion that returns, and the same hostname', async () => {
    const demoId = await walk(['CLAIMED']);
    const label = await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'PROVISIONING');
    await provisioner.transition(demoId, 'LIVE');
    await provisioner.extend(demoId);
    const extended = (await provisioner.currentState(demoId))!;
    await provisioner.transition(demoId, 'PROMOTING');
    const returned = await provisioner.transition(demoId, 'EXTENDED');
    expect(returned.leaseEndsAt).toEqual(extended.leaseEndsAt);
    expect(await provisioner.hostname(demoId)).toBe(label);
  });

  it('cannot start from EXTENDED: the transition set has no such exit', async () => {
    const demoId = await walk(PATH.EXTENDED);
    await expect(provisioner.transition(demoId, 'REBUILDING')).rejects.toThrow(
      ForbiddenTransitionError
    );
  });
});

describe('the table itself refuses what the operation would not make', () => {
  const NOW = at('2030-01-08T00:00:00Z');
  const END = at('2030-01-15T00:00:00Z');
  const WITHOUT_TERM: readonly DemoState[] = [
    'VERIFIED',
    'WAITING',
    'CLAIMED',
    'FAILED',
    'KILLED',
    'FROZEN',
  ];

  /** A row claiming `from` to `to` as position 2 after position 1, with every other check satisfied. */
  function claim(demoId: string, from: DemoState, to: DemoState): Promise<unknown> {
    const leased = !WITHOUT_TERM.includes(to);
    return plant({
      demoId,
      sequence: 2,
      previousSequence: 1,
      fromState: from,
      toState: to,
      leaseIssuedAt: leased ? NOW : null,
      leaseEndsAt: leased ? END : null,
      recordedAt: NOW,
    });
  }

  const forbidden = DEMO_STATES.flatMap((from) =>
    DEMO_STATES.filter((to) => !isAllowedTransition(from, to)).map((to) => [from, to] as const)
  );

  it.each(forbidden)(
    'refuses %s to %s on a database that has never seen the operation',
    async (from, to) => {
      expect(await refusal(claim(randomUUID(), from, to))).toMatchObject({
        code: '23514',
        constraint: 'demo_state_event_transition_allowed',
      });
    }
  );

  it('refuses a first row that is not VERIFIED from nothing', async () => {
    const first = (to: string, from: string | null, previous: number | null): Promise<unknown> =>
      plant({
        demoId: randomUUID(),
        sequence: 1,
        previousSequence: previous,
        fromState: from,
        toState: to,
      });
    expect(await refusal(first('CLAIMED', null, null))).toMatchObject({
      constraint: 'demo_state_event_transition_allowed',
    });
    expect(await refusal(first('CLAIMED', 'VERIFIED', null))).toMatchObject({
      constraint: 'demo_state_event_sequence_chain',
    });
    expect(await refusal(first('VERIFIED', null, 0))).toMatchObject({
      constraint: 'demo_state_event_sequence_chain',
    });
  });

  it('refuses a row that does not continue the demo’s real previous row', async () => {
    const demoId = await walk(['CLAIMED']);
    const stale = (
      sequence: number,
      previous: number,
      from: string,
      to: string
    ): Promise<unknown> =>
      plant({ demoId, sequence, previousSequence: previous, fromState: from, toState: to });
    // The latest row is CLAIMED; a row that says it moves on from VERIFIED is a stale worker's.
    expect(await refusal(stale(3, 1, 'VERIFIED', 'WAITING'))).toMatchObject({
      constraint: 'demo_state_event_sequence_chain',
    });
    expect(await refusal(stale(3, 2, 'VERIFIED', 'WAITING'))).toMatchObject({
      code: '23503',
      constraint: 'demo_state_event_continues_previous_fk',
    });
    expect(await refusal(stale(5, 4, 'CLAIMED', 'WAITING'))).toMatchObject({
      code: '23503',
      constraint: 'demo_state_event_continues_previous_fk',
    });
  });

  it('refuses a second row at a position already taken', async () => {
    const demoId = await walk(['CLAIMED']);
    expect(
      await refusal(
        plant({
          demoId,
          sequence: 2,
          previousSequence: 1,
          fromState: 'VERIFIED',
          toState: 'WAITING',
        })
      )
    ).toMatchObject({ code: '23505' });
  });
});

describe('two transitions of one demo cannot both be recorded', () => {
  it('fails the later writer with a typed error when another row took the next position first', async () => {
    const demoId = await walk(PATH.LIVE);
    const live = (await provisioner.currentState(demoId))!;
    let releaseCompetitor!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCompetitor = resolve;
    });
    let competitorInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      competitorInserted = resolve;
    });
    // A competing transaction takes position 5 and holds it open.
    const competitor = fx.adminDb.transaction(async (tx) => {
      await tx.insert(demoStateEvent).values({
        demoId,
        sequence: 5,
        previousSequence: 4,
        fromState: 'LIVE',
        toState: 'EXPIRING',
        leaseIssuedAt: live.leaseIssuedAt,
        leaseEndsAt: live.leaseEndsAt,
      });
      competitorInserted();
      await gate;
    });
    await inserted;
    // The operation reads the latest committed row (LIVE), then waits on the open position.
    const settled = provisioner.transition(demoId, 'PROMOTING').then(
      () => 'recorded',
      (error: unknown) => error
    );
    await waitForLockWait(fx.adminDb);
    releaseCompetitor();
    await competitor;
    expect(await settled).toBeInstanceOf(ConcurrentTransitionError);
    expect(await reachedState(demoId)).toBe('EXPIRING');
    expect((await provisioner.history(demoId)).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  }, 30000);

  it('records exactly one of many simultaneous identical transitions', async () => {
    const demoId = await walk(PATH.LIVE);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => provisioner.transition(demoId, 'EXPIRING'))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect([ConcurrentTransitionError, ForbiddenTransitionError]).toContainEqual(
          (result.reason as Error).constructor
        );
      }
    }
    expect(
      (await provisioner.history(demoId)).map((e) => e.toState).filter((s) => s === 'EXPIRING')
    ).toHaveLength(1);
  }, 30000);
});
