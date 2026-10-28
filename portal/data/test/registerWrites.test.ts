import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantRegister } from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import {
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  createFixture,
  rejection,
  rootMessage,
  type Fixture,
} from './helpers.js';

const NEWCOMER = '66666666-6666-4666-8666-666666666666';
const NEWCOMER_ORG = 'org-newcomer';

let fx: Fixture;
let db: TenantDb;

beforeAll(async () => {
  fx = await createFixture();
  db = new TenantDb(fx.tenant);
});

afterAll(async () => {
  await fx.close();
});

async function registerRows(): Promise<Array<{ tenantId: string; zitadelOrgId: string }>> {
  return fx.adminDb
    .select({ tenantId: tenantRegister.tenantId, zitadelOrgId: tenantRegister.zitadelOrgId })
    .from(tenantRegister)
    .orderBy(tenantRegister.zitadelOrgId);
}

const SEEDED = [
  { tenantId: TENANT_A, zitadelOrgId: ORG_A },
  { tenantId: TENANT_B, zitadelOrgId: ORG_B },
];

/** The tenant role's attempt at each write, made through the bound unit of work. */
function insertOwnRow(): Promise<unknown> {
  return db.run(bindTenant(NEWCOMER), (tx) =>
    tx
      .insert(tenantRegister)
      .values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG, kind: 'REAL' })
  );
}

function updateOwnRow(): Promise<unknown> {
  return db.run(bindTenant(TENANT_A), (tx) =>
    tx
      .update(tenantRegister)
      .set({ zitadelOrgId: 'taken' })
      .where(eq(tenantRegister.tenantId, TENANT_A))
  );
}

function deleteOwnRow(): Promise<unknown> {
  return db.run(bindTenant(TENANT_A), (tx) =>
    tx.delete(tenantRegister).where(eq(tenantRegister.tenantId, TENANT_A))
  );
}

async function expectPermissionDenied(attempt: Promise<unknown>): Promise<void> {
  expect(rootMessage(await rejection(attempt))).toMatch(
    /permission denied for table tenant_register/
  );
}

describe('the register is read-only for the tenant role', () => {
  it('reads its own row and no other', async () => {
    const rows = await db.run(bindTenant(TENANT_A), (tx) => tx.select().from(tenantRegister));
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it('refuses an INSERT for the bound tenant itself', async () => {
    await expectPermissionDenied(insertOwnRow());
  });

  it('refuses an UPDATE of its own row', async () => {
    await expectPermissionDenied(updateOwnRow());
  });

  it('refuses a DELETE of its own row', async () => {
    await expectPermissionDenied(deleteOwnRow());
  });

  it('leaves the register as it was seeded', async () => {
    expect(await registerRows()).toEqual(SEEDED);
  });
});

/**
 * Grants the tenant role the writes it does not hold, so the policy's own
 * `WITH CHECK` and `USING` are what stand between a tenant and another
 * tenant's register row. The grant and everything the work added or changed
 * are undone whatever the work does.
 */
async function withRegisterWrites(work: () => Promise<void>): Promise<void> {
  try {
    await fx.admin.query('GRANT INSERT, UPDATE, DELETE ON portal.tenant_register TO portal_tenant');
    await work();
  } finally {
    await fx.admin.query(
      'REVOKE INSERT, UPDATE, DELETE ON portal.tenant_register FROM portal_tenant'
    );
    await fx.adminDb
      .delete(tenantRegister)
      .where(notInArray(tenantRegister.tenantId, [TENANT_A, TENANT_B]));
    await fx.adminDb
      .update(tenantRegister)
      .set({ zitadelOrgId: ORG_A })
      .where(eq(tenantRegister.tenantId, TENANT_A));
  }
}

describe('the register policy, with the writes granted for the test', () => {
  it('refuses a row for another tenant, by the policy', async () => {
    await withRegisterWrites(async () => {
      const error = await rejection(
        db.run(bindTenant(TENANT_A), (tx) =>
          tx
            .insert(tenantRegister)
            .values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG, kind: 'REAL' })
        )
      );
      expect(rootMessage(error)).toMatch(/row-level security policy for table "tenant_register"/);
      expect(await registerRows()).toEqual(SEEDED);
    });
  });

  // An update that names columns in its WHERE also needs the policy's USING to
  // pass on the new row, so this holds the policy as a whole; the insert above is
  // the case only the WITH CHECK answers.
  it('refuses an update that moves its own row to another tenant, by the policy', async () => {
    await withRegisterWrites(async () => {
      const error = await rejection(
        db.run(bindTenant(TENANT_A), (tx) =>
          tx
            .update(tenantRegister)
            .set({ tenantId: NEWCOMER })
            .where(eq(tenantRegister.tenantId, TENANT_A))
        )
      );
      expect(rootMessage(error)).toMatch(/row-level security policy for table "tenant_register"/);
      expect(await registerRows()).toEqual(SEEDED);
    });
  });

  it('cannot delete another tenant: the row is not visible to remove', async () => {
    await withRegisterWrites(async () => {
      const removed = await db.run(bindTenant(TENANT_A), (tx) =>
        tx.delete(tenantRegister).where(eq(tenantRegister.tenantId, TENANT_B)).returning()
      );
      expect(removed).toEqual([]);
      expect(await registerRows()).toEqual(SEEDED);
    });
  });

  it('accepts a row for the bound tenant itself', async () => {
    await withRegisterWrites(async () => {
      await db.run(bindTenant(NEWCOMER), (tx) =>
        tx
          .insert(tenantRegister)
          .values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG, kind: 'REAL' })
      );
      expect((await registerRows()).map((row) => row.tenantId)).toContain(NEWCOMER);
    });
  });

  it('leaves the register read-only and as seeded afterwards', async () => {
    await expectPermissionDenied(insertOwnRow());
    await expectPermissionDenied(updateOwnRow());
    await expectPermissionDenied(deleteOwnRow());
    expect(await registerRows()).toEqual(SEEDED);
  });
});
