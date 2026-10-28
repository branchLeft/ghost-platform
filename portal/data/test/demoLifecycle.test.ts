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

/** Every stored column of one demo's rows, as the database prints them (microseconds kept). */
async function storedRows(demoId: string): Promise<Record<string, unknown>[]> {
  const result = await fx.admin.query<{ row: Record<string, unknown> }>(
    'SELECT to_jsonb(e) AS row FROM portal.demo_state_event e WHERE demo_id = $1 ORDER BY sequence',
    [demoId]
  );
  return result.rows.map((r) => r.row);
}

async function storedRegisterRows(demoId: string): Promise<Record<string, unknown>[]> {
  const result = await fx.admin.query<{ row: Record<string, unknown> }>(
    'SELECT to_jsonb(r) AS row FROM portal.hostname_register r WHERE demo_id = $1',
    [demoId]
  );
  return result.rows.map((r) => r.row);
}

async function seconds(
  from: string,
  to: string,
  demoId: string,
  sequence: number
): Promise<number> {
  const result = await fx.admin.query<{ s: string }>(
    `SELECT extract(epoch FROM ${to} - ${from})::text AS s FROM portal.demo_state_event
      WHERE demo_id = $1 AND sequence = $2`,
    [demoId, sequence]
  );
  return Number(result.rows[0]!.s);
}

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
    const before = await fx.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const event = await provisioner.transition(demoId, 'PROVISIONING');
    const after = await fx.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    expect(event.leaseIssuedAt!.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.now.getTime() - 1
    );
    expect(event.leaseIssuedAt!.getTime()).toBeLessThanOrEqual(after.rows[0]!.now.getTime());
    const stored = await storedRows(demoId);
    const row = stored.at(-1)!;
    expect(row['to_state']).toBe('PROVISIONING');
    expect(await seconds('lease_issued_at', 'lease_ends_at', demoId, 3)).toBe(7 * 24 * 3600);
    expect(row['lease_issued_at']).toBe(row['recorded_at']);
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
    const insert = (issued: string, ends: string): Promise<unknown> =>
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at, recorded_at)
         VALUES ($1, 3, 2, 'CLAIMED', 'PROVISIONING', $2, $3, '2030-01-08T00:00:00Z')`,
        [demoId, issued, ends]
      );
    await expect(insert('2030-01-08T00:00:00Z', '2030-01-14T00:00:00Z')).rejects.toMatchObject({
      constraint: 'demo_state_event_term_set',
    });
    await expect(insert('2029-12-01T00:00:00Z', '2029-12-08T00:00:00Z')).rejects.toMatchObject({
      constraint: 'demo_state_event_term_set',
    });
    await insert('2030-01-08T00:00:00Z', '2030-01-15T00:00:00Z');
  });

  it('never has a null end from PROVISIONING on', async () => {
    const demoId = await walk(['CLAIMED']);
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 3, 2, 'CLAIMED', 'PROVISIONING')`,
        [demoId]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_lease_by_state' });
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at)
         VALUES ($1, 3, 2, 'CLAIMED', 'KILLED', now())`,
        [demoId]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_lease_complete' });
  });

  it('refuses at the table a term whose end is not after its start, and a term before PROVISIONING', async () => {
    const demoId = await walk(['CLAIMED', 'PROVISIONING']);
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at)
         VALUES ($1, 4, 3, 'PROVISIONING', 'LIVE', '2030-01-08T00:00:00Z', '2030-01-01T00:00:00Z')`,
        [demoId]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_lease_finite' });
    const early = await walk(['CLAIMED']);
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at)
         VALUES ($1, 3, 2, 'CLAIMED', 'KILLED', now(), now() + interval '1 day')`,
        [early]
      )
    ).resolves.toBeDefined();
    const waiting = await walk(['CLAIMED']);
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at)
         VALUES ($1, 3, 2, 'CLAIMED', 'WAITING', now(), now() + interval '1 day')`,
        [waiting]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_lease_by_state' });
  });
});

describe('the extension: the end moves by 14 days and nothing else', () => {
  it('adds 14 days to the end of the term, leaving the issue time and every earlier row as they were', async () => {
    const demoId = await walk(['CLAIMED']);
    await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'PROVISIONING');
    await provisioner.transition(demoId, 'LIVE');
    const before = await storedRows(demoId);
    const registerBefore = await storedRegisterRows(demoId);
    const event = await provisioner.extend(demoId);
    const after = await storedRows(demoId);
    expect(after).toHaveLength(before.length + 1);
    // Every earlier row is byte for byte the same.
    expect(after.slice(0, before.length)).toEqual(before);
    // The new row differs from the one before it in the transition and the end alone.
    const strip = (row: Record<string, unknown>): Record<string, unknown> => {
      const copy = { ...row };
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
    const endShift = await fx.admin.query<{ s: string }>(
      `SELECT extract(epoch FROM b.lease_ends_at - a.lease_ends_at)::text AS s
         FROM portal.demo_state_event a, portal.demo_state_event b
        WHERE a.demo_id = $1 AND b.demo_id = $1 AND a.sequence = $2 AND b.sequence = $3`,
      [demoId, before.length, before.length + 1]
    );
    expect(Number(endShift.rows[0]!.s)).toBe(14 * 24 * 3600);
    expect(event.toState).toBe('EXTENDED');
    // The register row is untouched.
    expect(registerBefore).toHaveLength(1);
    expect(await storedRegisterRows(demoId)).toEqual(registerBefore);
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
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at, extension_days)
         SELECT demo_id, 5, 4, 'LIVE', 'EXPIRING', lease_issued_at, lease_ends_at, 14
           FROM portal.demo_state_event WHERE demo_id = $1 AND sequence = 4`,
        [demoId]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_extension_only_extended' });
  });
});

describe('a rebuild keeps the term', () => {
  it('stores the same issue time and end on the rebuilt LIVE row, to the microsecond, and is no extension', async () => {
    const demoId = await walk(PATH.LIVE);
    await provisioner.transition(demoId, 'REBUILDING');
    await provisioner.transition(demoId, 'LIVE');
    const rows = await storedRows(demoId);
    const [live, rebuilding, rebuilt] = [rows[3]!, rows[4]!, rows[5]!];
    expect(rebuilding['lease_ends_at']).toBe(live['lease_ends_at']);
    expect(rebuilt['lease_ends_at']).toBe(live['lease_ends_at']);
    expect(rebuilt['lease_issued_at']).toBe(live['lease_issued_at']);
    expect(rebuilt['extension_days']).toBe(0);
    expect(rebuilt['recorded_at']).not.toBe(live['recorded_at']);
  });

  it('on day six still ends on day seven', async () => {
    const demoId = randomUUID();
    await fx.admin.query(
      `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
       VALUES ($1, 1, NULL, NULL, 'VERIFIED'), ($1, 2, 1, 'VERIFIED', 'CLAIMED')`,
      [demoId]
    );
    await fx.admin.query(
      `INSERT INTO portal.demo_state_event
         (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at, recorded_at)
       SELECT $1, s.sequence, s.sequence - 1, s.from_state, s.to_state, t.issued, t.issued + interval '168 hours', t.issued
         FROM (VALUES (3, 'CLAIMED', 'PROVISIONING'), (4, 'PROVISIONING', 'LIVE')) AS s(sequence, from_state, to_state),
              (SELECT now() - interval '6 days' AS issued) t`,
      [demoId]
    );
    const before = (await storedRows(demoId)).at(-1)!;
    await provisioner.transition(demoId, 'REBUILDING');
    const rebuilt = await provisioner.transition(demoId, 'LIVE');
    const after = (await storedRows(demoId)).at(-1)!;
    expect(after['lease_ends_at']).toBe(before['lease_ends_at']);
    const remaining = rebuilt.leaseEndsAt!.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(24 * 3600 * 1000);
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
  const NOW = '2030-01-08T00:00:00Z';
  const END = '2030-01-15T00:00:00Z';

  /** A row claiming `from` to `to` as position 2 after position 1, with every other check satisfied. */
  function claim(
    demoId: string,
    from: DemoState,
    to: DemoState
  ): Promise<{ rowCount: number | null }> {
    const leased = ![...'VERIFIED WAITING CLAIMED FAILED KILLED FROZEN'.split(' ')].includes(to);
    return fx.admin.query(
      `INSERT INTO portal.demo_state_event
         (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at, recorded_at)
       VALUES ($1, 2, 1, $2, $3, $4, $5, $6)`,
      [demoId, from, to, leased ? NOW : null, leased ? END : null, NOW]
    );
  }

  const forbidden = DEMO_STATES.flatMap((from) =>
    DEMO_STATES.filter((to) => !isAllowedTransition(from, to)).map((to) => [from, to] as const)
  );

  it.each(forbidden)(
    'refuses %s to %s on a database that has never seen the operation',
    async (from, to) => {
      await expect(claim(randomUUID(), from, to)).rejects.toMatchObject({
        code: '23514',
        constraint: 'demo_state_event_transition_allowed',
      });
    }
  );

  it('refuses a first row that is not VERIFIED from nothing', async () => {
    const insert = (to: string, from: string | null, previous: number | null): Promise<unknown> =>
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 1, $2, $3, $4)`,
        [randomUUID(), previous, from, to]
      );
    await expect(insert('CLAIMED', null, null)).rejects.toMatchObject({
      constraint: 'demo_state_event_transition_allowed',
    });
    await expect(insert('CLAIMED', 'VERIFIED', null)).rejects.toMatchObject({
      constraint: 'demo_state_event_sequence_chain',
    });
    await expect(insert('VERIFIED', null, 0)).rejects.toMatchObject({
      constraint: 'demo_state_event_sequence_chain',
    });
  });

  it('refuses a row that does not continue the demo’s real previous row', async () => {
    const demoId = await walk(['CLAIMED']);
    // The latest row is CLAIMED; a row that says it moves on from VERIFIED is a stale worker's.
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 3, 1, 'VERIFIED', 'WAITING')`,
        [demoId]
      )
    ).rejects.toMatchObject({ constraint: 'demo_state_event_sequence_chain' });
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 3, 2, 'VERIFIED', 'WAITING')`,
        [demoId]
      )
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'demo_state_event_continues_previous_fk',
    });
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 5, 4, 'CLAIMED', 'WAITING')`,
        [demoId]
      )
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'demo_state_event_continues_previous_fk',
    });
  });

  it('refuses a second row at a position already taken', async () => {
    const demoId = await walk(['CLAIMED']);
    await expect(
      fx.admin.query(
        `INSERT INTO portal.demo_state_event (demo_id, sequence, previous_sequence, from_state, to_state)
         VALUES ($1, 2, 1, 'VERIFIED', 'WAITING')`,
        [demoId]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('two transitions of one demo cannot both be recorded', () => {
  it('fails the later writer with a typed error when another row took the next position first', async () => {
    const demoId = await walk(PATH.LIVE);
    const competitor = await fx.admin.connect();
    try {
      await competitor.query('BEGIN');
      await competitor.query(
        `INSERT INTO portal.demo_state_event
           (demo_id, sequence, previous_sequence, from_state, to_state, lease_issued_at, lease_ends_at)
         SELECT demo_id, 5, 4, 'LIVE', 'EXPIRING', lease_issued_at, lease_ends_at
           FROM portal.demo_state_event WHERE demo_id = $1 AND sequence = 4`,
        [demoId]
      );
      // The operation reads the latest committed row (LIVE), then waits on the open position.
      const racing = provisioner.transition(demoId, 'PROMOTING');
      const settled = racing.then(
        () => 'recorded',
        (error: unknown) => error
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await fx.admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
        );
        if (waiting.rowCount !== 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await competitor.query('COMMIT');
      expect(await settled).toBeInstanceOf(ConcurrentTransitionError);
    } finally {
      competitor.release();
    }
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
