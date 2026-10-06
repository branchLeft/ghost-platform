import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDb } from '../src/owner/index.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { UnisolatedTableError, assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import { MalformedScrapeError } from '../src/reading.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const scrape = (drained: boolean, version?: string, match?: boolean): string =>
  [
    `drain_sidecar_drained ${drained ? 1 : 0}`,
    ...(version === undefined ? [] : [`drain_sidecar_ghost_version_info{version="${version}"} 1`]),
    ...(match === undefined ? [] : [`drain_sidecar_version_match ${match ? 1 : 0}`]),
  ].join('\n');

const T0 = new Date('2026-10-01T10:00:00Z');
const T1 = new Date('2026-10-02T10:00:00Z');
const T2 = new Date('2026-10-03T10:00:00Z');

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  // A is steady on the intended version; B was reverted after a failed bump.
  await owner.recordReading(TENANT_A, [scrape(false, '6.55.0', true)], T0);
  await owner.recordReading(TENANT_B, [scrape(true), scrape(false, '6.54.0', false)], T0);
});

afterAll(async () => {
  await fixture.close();
});

describe('health_reading isolation', () => {
  it('is covered by the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
    expect(UnisolatedTableError).toBeDefined();
  });

  it("gives tenant A its own reading and never B's", async () => {
    const own = await tenant.ownHealth(bindTenant(TENANT_A));
    expect(own).toMatchObject({
      health: 'healthy',
      reportedVersion: '6.55.0',
      versionMatch: true,
      mismatchSince: null,
    });
    const rows = await tenant.run(bindTenant(TENANT_A), (tx) =>
      tx.select().from(schema.healthReading)
    );
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it("gives tenant B its own dated mismatch and nothing of A's", async () => {
    const own = await tenant.ownHealth(bindTenant(TENANT_B));
    expect(own).toMatchObject({
      reportedVersion: '6.54.0',
      versionMatch: false,
      mismatchSince: T0,
    });
    const rows = await tenant.run(bindTenant(TENANT_B), (tx) =>
      tx.select().from(schema.healthReading)
    );
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_B]);
  });

  it('refuses a tenant writing a reading, its own or another tenant’s', async () => {
    for (const id of [TENANT_A, TENANT_B]) {
      await expect(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.insert(schema.healthReading).values({
            tenantId: id,
            health: 'healthy',
            observedAt: T1,
          })
        )
      ).rejects.toThrow();
    }
    await expect(
      tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.update(schema.healthReading).set({ health: 'unknown' })
      )
    ).rejects.toThrow();
  });

  it('refuses a stored health the table does not know', async () => {
    await expect(
      fixture.adminDb.insert(schema.healthReading).values({
        tenantId: TENANT_A,
        health: 'bogus',
        observedAt: T1,
      })
    ).rejects.toThrow();
  });
});

describe('the owner read', () => {
  it('lists every tenant with its reading', async () => {
    const all = await owner.listHealth();
    expect(all.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_B]);
    expect(all[0]?.health?.versionMatch).toBe(true);
    expect(all[1]?.health).toMatchObject({ versionMatch: false, mismatchSince: T0 });
  });
});

describe('recordReading', () => {
  it('keeps the first date of a continuing mismatch, then clears it on a match', async () => {
    await owner.recordReading(TENANT_B, [scrape(false, '6.54.0', false)], T1);
    expect((await tenant.ownHealth(bindTenant(TENANT_B)))?.mismatchSince).toEqual(T0);
    expect((await tenant.ownHealth(bindTenant(TENANT_B)))?.observedAt).toEqual(T1);

    await owner.recordReading(TENANT_B, [], T1);
    expect(await tenant.ownHealth(bindTenant(TENANT_B))).toMatchObject({
      health: 'unknown',
      reportedVersion: null,
      mismatchSince: T0,
    });

    await owner.recordReading(TENANT_B, [scrape(false, '6.55.0', true)], T2);
    expect(await tenant.ownHealth(bindTenant(TENANT_B))).toMatchObject({
      versionMatch: true,
      mismatchSince: null,
    });
  });

  it('dates a fresh mismatch from its own first reading', async () => {
    await owner.recordReading(TENANT_A, [scrape(false, '6.54.0', false)], T2);
    expect((await tenant.ownHealth(bindTenant(TENANT_A)))?.mismatchSince).toEqual(T2);
  });

  it('refuses an unreadable scrape and a tenant id that is not one, writing nothing', async () => {
    await expect(owner.recordReading(TENANT_A, ['nonsense'], T2)).rejects.toBeInstanceOf(
      MalformedScrapeError
    );
    await expect(owner.recordReading('not-a-tenant', [], T2)).rejects.toThrow();
  });

  it('refuses a reading for a tenant that is not registered', async () => {
    await expect(
      owner.recordReading('33333333-3333-4333-8333-333333333333', [], T2)
    ).rejects.toThrow();
  });

  it('lists a registered tenant with no reading as null', async () => {
    await fixture.adminDb
      .delete(schema.healthReading)
      .where(eq(schema.healthReading.tenantId, TENANT_A));
    const all = await owner.listHealth();
    expect(all.find((row) => row.tenantId === TENANT_A)?.health).toBeNull();
    expect(await tenant.ownHealth(bindTenant(TENANT_A))).toBeNull();
  });
});
