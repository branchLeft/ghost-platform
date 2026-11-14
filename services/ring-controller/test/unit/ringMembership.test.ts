import { afterAll, describe, expect, it } from 'vitest';
import * as real from '../../src/ringMembership.js';
import { runRelease, type RingMember } from '../../src/ringController.js';
import type { RingName } from '../../src/rings.js';
import { CLEAN_ENV, RELEASE, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

const { createListMembers, parseRingAssignments, RingAssignmentError } = real;

type Module = typeof real;

afterAll(() => {
  cleanupSabotageTmp();
});

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('ringMembership.ts', mutations);

/** Ring 0 holds the demo-slot canary and the MySQL tenant-zero canary. */
const GOOD = {
  'slot-0': ['slot-canary', 'zero-canary'],
  demos: ['demo-1'],
  entry: ['entry-1'],
  professional: ['pro-1'],
};

const ENGINES: Record<string, RingMember['engine']> = {
  'slot-canary': 'sqlite',
  'zero-canary': 'mysql',
  'demo-1': 'sqlite',
  'entry-1': 'mysql',
  'pro-1': 'mysql',
};

const engineOf = (tenantId: string) => ENGINES[tenantId] as RingMember['engine'];

describe('parseRingAssignments', () => {
  it('accepts every ring named once with disjoint tenants, and freezes the result', () => {
    const parsed = parseRingAssignments(GOOD);
    expect(parsed).toEqual(GOOD);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed['slot-0'])).toBe(true);
  });

  it('accepts an empty ring', () => {
    expect(parseRingAssignments({ ...GOOD, demos: [] }).demos).toEqual([]);
  });

  it.each([
    ['not an object', 'slot-0', /keyed by ring name/],
    ['an array', [], /keyed by ring name/],
    ['null', null, /keyed by ring name/],
    ['a missing ring', { 'slot-0': [], demos: [], entry: [] }, /ring 'professional' must be named/],
    ['an unknown ring', { ...GOOD, 'ring-9': [] }, /unknown ring 'ring-9'/],
    ['a ring that is not a list', { ...GOOD, demos: 'demo-1' }, /ring 'demos' must be named/],
    ['an empty tenant id', { ...GOOD, demos: [''] }, /not a plain string/],
    ['a padded tenant id', { ...GOOD, demos: [' demo-1'] }, /not a plain string/],
    ['a non-string tenant id', { ...GOOD, demos: [7] }, /not a plain string/],
    ['a tenant twice in one ring', { ...GOOD, demos: ['d', 'd'] }, /listed twice in ring 'demos'/],
    [
      'a tenant in two rings',
      { ...GOOD, entry: ['zero-canary'] },
      /in both ring 'slot-0' and ring 'entry'/,
    ],
  ])('refuses %s', (_name, input, message) => {
    expect(() => parseRingAssignments(input)).toThrow(RingAssignmentError);
    expect(() => parseRingAssignments(input)).toThrow(message);
  });
});

describe('createListMembers', () => {
  it('lists a ring in assignment order, with each engine read through engineOf', async () => {
    const list = createListMembers(parseRingAssignments(GOOD), engineOf);
    expect(await list('slot-0')).toEqual([
      { tenantId: 'slot-canary', engine: 'sqlite' },
      { tenantId: 'zero-canary', engine: 'mysql' },
    ]);
  });

  it('refuses an engine that is neither sqlite nor mysql', async () => {
    const list = createListMembers(
      parseRingAssignments(GOOD),
      () => 'postgres' as unknown as RingMember['engine']
    );
    await expect(list('slot-0')).rejects.toThrow(/engine that is not known/);
  });

  it('passes on a throw from engineOf', async () => {
    const list = createListMembers(parseRingAssignments(GOOD), () => {
      throw new Error('descriptor unreadable');
    });
    await expect(list('slot-0')).rejects.toThrow('descriptor unreadable');
  });

  it('refuses a ring it holds no assignment for', async () => {
    const list = createListMembers(parseRingAssignments(GOOD), engineOf);
    await expect(list('ring-9' as RingName)).rejects.toThrow(/no assignment for ring 'ring-9'/);
  });
});

describe('a release over assigned rings', () => {
  const drive = (assignments: unknown, resolve = engineOf) => {
    const list = createListMembers(parseRingAssignments(assignments), resolve);
    const members = Object.fromEntries(
      Object.entries(parseRingAssignments(assignments)).map(([ring, ids]) => [
        ring,
        // The fleet only needs ring membership for its own bookkeeping; the
        // controller sees engines through `list`, which reads `resolve`.
        ids.map((tenantId) => ({ tenantId, engine: engineOf(tenantId) })),
      ])
    );
    const fleet = makeFleet({ members, listMembers: list });
    return { fleet, outcome: runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV) };
  };

  it('promotes when ring 0 holds the MySQL canary, bumping both of its members first', async () => {
    const { fleet, outcome } = drive(GOOD);
    expect(await outcome).toEqual({ status: 'completed' });
    expect(fleet.bumpOrder().slice(0, 2)).toEqual(['slot-canary', 'zero-canary']);
  });

  it('holds before ring 2 when the MySQL tenant is assigned to a later ring', async () => {
    const moved = { ...GOOD, 'slot-0': ['slot-canary'], demos: ['demo-1', 'zero-canary'] };
    const { fleet, outcome } = drive(moved);
    expect(await outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'no-mysql-in-ring-0',
    });
    expect(fleet.bumpOrder()).not.toContain('entry-1');
  });

  it('holds before ring 2 when the engine read for the ring 0 tenant is sqlite', async () => {
    const { fleet, outcome } = drive(GOOD, (tenantId) =>
      tenantId === 'zero-canary' ? 'sqlite' : engineOf(tenantId)
    );
    expect(await outcome).toMatchObject({ status: 'held', reason: 'no-mysql-in-ring-0' });
    expect(fleet.bumpOrder()).not.toContain('entry-1');
  });

  it('holds at ring 0 as probe-failed when an engine cannot be read, bumping nothing', async () => {
    const { fleet, outcome } = drive(GOOD, (tenantId) => {
      if (tenantId === 'zero-canary') throw new Error('descriptor unreadable');
      return engineOf(tenantId);
    });
    expect(await outcome).toMatchObject({ status: 'held', at: 'slot-0', reason: 'probe-failed' });
    expect(fleet.bumpOrder()).toEqual([]);
  });
});

describe('sabotage pairs: each fails on a broken copy and holds on the real module', () => {
  async function expectPair(
    mutations: Mutation[],
    scenario: (mod: Module) => Promise<boolean>
  ): Promise<void> {
    expect(await scenario(await sabotaged(...mutations))).toBe(false);
    expect(await scenario(real)).toBe(true);
  }

  const refuses = (mod: Module, input: unknown): boolean => {
    try {
      mod.parseRingAssignments(input);
      return false;
    } catch (error) {
      return (error as Error).name === 'RingAssignmentError';
    }
  };

  it('a tenant in two rings is refused', () =>
    expectPair(
      [
        {
          file: 'ringMembership.ts',
          find: 'if (already !== undefined) {',
          replace: 'if (false) {',
        },
      ],
      async (mod) => refuses(mod, { ...GOOD, entry: ['zero-canary'] })
    ));

  it('a ring that is not named is refused', () =>
    expectPair(
      [
        {
          file: 'ringMembership.ts',
          find: 'if (!Array.isArray(list)) {',
          replace: 'if (false) {',
        },
      ],
      async (mod) => refuses(mod, { 'slot-0': [], demos: [], entry: [] })
    ));

  it('an unknown ring is refused', () =>
    expectPair(
      [
        {
          file: 'ringMembership.ts',
          find: 'if (!(RING_ORDER as readonly string[]).includes(key)) {',
          replace: 'if (false) {',
        },
      ],
      async (mod) => refuses(mod, { ...GOOD, 'ring-9': [] })
    ));

  it('an engine label from the data cannot stand in for the engine that is read', () =>
    expectPair(
      [
        {
          file: 'ringMembership.ts',
          find: "if (engine !== 'sqlite' && engine !== 'mysql') {",
          replace: 'if (false) {',
        },
      ],
      async (mod) => {
        const list = mod.createListMembers(
          mod.parseRingAssignments(GOOD),
          () => 'postgres' as unknown as RingMember['engine']
        );
        return list('slot-0').then(
          () => false,
          () => true
        );
      }
    ));
});
