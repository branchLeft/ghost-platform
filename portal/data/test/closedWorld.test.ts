import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRAS, MISSING, MORE_EXTRAS, type Tamper } from './closedWorldFixtures.js';
import { withHba } from './hbaFile.js';
import { OTHER_DB, admin, resetServer, run, serverMajor, stateSnapshot } from './provisionSetup.js';

// The closed-world property: from a correctly provisioned database, any one
// change the manifest does not hold, extra or missing, makes the command exit
// 1, name the mechanism and the object, and write nothing at all.

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];

describe('the closed-world property', () => {
  if (ADMIN_URL === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }
  let major = 0;

  beforeAll(async () => {
    await resetServer();
    major = await serverMajor();
    const first = await run();
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    await admin('postgres', `CREATE DATABASE ${OTHER_DB}`);
  }, 120000);

  afterAll(async () => {
    await resetServer();
  }, 60000);

  async function apply(steps: Tamper['apply']): Promise<void> {
    for (const [database, sql] of steps) await admin(database, sql);
  }

  async function refusedWithNoWrite(tamper: Tamper): Promise<void> {
    const before = await stateSnapshot();
    const result = await run();
    const after = await stateSnapshot();
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toMatch(tamper.expect);
    expect(result.err.at(-1)).toMatch(/^provision failed: refused: \d+ difference/);
    expect(after).toEqual(before);
  }

  async function exercise(tamper: Tamper): Promise<void> {
    if (tamper.since !== undefined && major < tamper.since) return;
    if (tamper.hba !== undefined) {
      await withHba(tamper.hba, true, () => refusedWithNoWrite(tamper));
    } else {
      await apply(tamper.apply);
      try {
        await refusedWithNoWrite(tamper);
      } finally {
        await apply(tamper.undo);
      }
    }
    // Undone, the same server passes again: the fixture left nothing behind.
    const clean = await run();
    expect(clean.err).toEqual([]);
    expect(clean.code).toBe(0);
  }

  describe('one extra per mechanism', () => {
    it.each(EXTRAS.map((t) => [t.id, t.title, t] as const))(
      '%s: %s',
      async (_id, _title, tamper) => exercise(tamper),
      60000
    );
  });

  describe('further extras', () => {
    it.each(MORE_EXTRAS.map((t) => [t.id, t.title, t] as const))(
      '%s: %s',
      async (_id, _title, tamper) => exercise(tamper),
      60000
    );
  });

  describe('one missing grant per ACL family', () => {
    it.each(MISSING.map((t) => [t.id, t.title, t] as const))(
      '%s: %s',
      async (_id, _title, tamper) => exercise(tamper),
      60000
    );
  });

  it('names every difference in one run, not only the first', async () => {
    const both = [EXTRAS.find((t) => t.id === 'M06')!, EXTRAS.find((t) => t.id === 'M29')!];
    for (const tamper of both) await apply(tamper.apply);
    try {
      const result = await run();
      expect(result.code).toBe(1);
      for (const tamper of both) expect(result.err.join('\n')).toMatch(tamper.expect);
    } finally {
      for (const tamper of both) await apply(tamper.undo);
    }
  });
});
