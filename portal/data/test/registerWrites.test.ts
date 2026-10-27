import { eq } from 'drizzle-orm';
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

async function holds(verb: string): Promise<boolean> {
  const result = await fx.admin.query<{ held: boolean }>(
    'SELECT has_table_privilege($1, $2, $3) AS held',
    ['portal_tenant', 'portal.tenant_register', verb]
  );
  return result.rows[0]?.held ?? false;
}

async function registerRows(): Promise<Array<{ tenant_id: string; zitadel_org_id: string }>> {
  const result = await fx.admin.query<{ tenant_id: string; zitadel_org_id: string }>(
    'SELECT tenant_id, zitadel_org_id FROM portal.tenant_register ORDER BY zitadel_org_id'
  );
  return result.rows;
}

const SEEDED = [
  { tenant_id: TENANT_A, zitadel_org_id: ORG_A },
  { tenant_id: TENANT_B, zitadel_org_id: ORG_B },
];

describe('the register is read-only for the tenant role', () => {
  it('holds SELECT and nothing that writes', async () => {
    expect(await holds('SELECT')).toBe(true);
    expect(await holds('INSERT')).toBe(false);
    expect(await holds('UPDATE')).toBe(false);
    expect(await holds('DELETE')).toBe(false);
  });

  it('refuses an INSERT for the bound tenant itself', async () => {
    const error = await rejection(
      db.run(bindTenant(NEWCOMER), (tx) =>
        tx.insert(tenantRegister).values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG })
      )
    );
    expect(rootMessage(error)).toMatch(/permission denied for table tenant_register/);
  });

  it('refuses an UPDATE of its own row', async () => {
    const error = await rejection(
      db.run(bindTenant(TENANT_A), (tx) =>
        tx
          .update(tenantRegister)
          .set({ zitadelOrgId: 'taken' })
          .where(eq(tenantRegister.tenantId, TENANT_A))
      )
    );
    expect(rootMessage(error)).toMatch(/permission denied for table tenant_register/);
  });

  it('refuses a DELETE of its own row', async () => {
    const error = await rejection(
      db.run(bindTenant(TENANT_A), (tx) =>
        tx.delete(tenantRegister).where(eq(tenantRegister.tenantId, TENANT_A))
      )
    );
    expect(rootMessage(error)).toMatch(/permission denied for table tenant_register/);
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
    await fx.admin.query('DELETE FROM portal.tenant_register WHERE tenant_id NOT IN ($1, $2)', [
      TENANT_A,
      TENANT_B,
    ]);
    await fx.admin.query(
      'UPDATE portal.tenant_register SET zitadel_org_id = $2 WHERE tenant_id = $1',
      [TENANT_A, ORG_A]
    );
  }
}

describe('the register policy, with the writes granted for the test', () => {
  it('refuses a row for another tenant, by the policy', async () => {
    await withRegisterWrites(async () => {
      const error = await rejection(
        db.run(bindTenant(TENANT_A), (tx) =>
          tx.insert(tenantRegister).values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG })
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
        tx.insert(tenantRegister).values({ tenantId: NEWCOMER, zitadelOrgId: NEWCOMER_ORG })
      );
      expect((await registerRows()).map((row) => row.tenant_id)).toContain(NEWCOMER);
    });
  });

  it('leaves the register read-only and as seeded afterwards', async () => {
    expect(await holds('INSERT')).toBe(false);
    expect(await holds('UPDATE')).toBe(false);
    expect(await holds('DELETE')).toBe(false);
    expect(await registerRows()).toEqual(SEEDED);
  });
});
