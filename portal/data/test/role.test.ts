import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../src/db.js';
import { OwnerDb } from '../src/owner/index.js';
import { TenantDb, bindTenant, type Tx } from '../src/tenant/index.js';
import { note } from './fixtureSchema.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await createFixture();
  await fx.adminDb.insert(note).values([
    { tenantId: TENANT_A, body: 'a1' },
    { tenantId: TENANT_B, body: 'b1' },
  ]);
});

afterAll(async () => {
  await fx.close();
});

// Read-only probe of the session's effective role, for these tests alone.
async function currentUser(tx: Tx): Promise<string> {
  const result = await tx.execute<{ who: string }>(sql`SELECT current_user AS who`);
  return result.rows[0]?.who ?? 'none';
}

// The test logins hold one role each, so their own grants would let a missing
// role switch pass unnoticed. These tests therefore assert the role itself, and
// use a login that holds both roles and bypasses row security, for which
// only the switch keeps a tenant-facing statement inside its policies.
describe('the tenant-facing role switch', () => {
  it('runs a tenant statement as portal_tenant', async () => {
    const who = await new TenantDb(fx.tenant).run(bindTenant(TENANT_A), currentUser);
    expect(who).toBe('portal_tenant');
  });

  it('runs as portal_tenant even for a login that could do more', async () => {
    const who = await new TenantDb(fx.dual).run(bindTenant(TENANT_A), currentUser);
    expect(who).toBe('portal_tenant');
  });

  it('keeps a login that bypasses row security inside the bound tenant', async () => {
    const rows = await new TenantDb(fx.dual).run(bindTenant(TENANT_A), (tx) =>
      tx.select().from(note)
    );
    expect(rows.map((r) => r.body)).toEqual(['a1']);
  });

  it('shows the login really could see everything without the switch', async () => {
    const rows = await connect(fx.dual).select().from(note);
    expect(rows.map((r) => r.body).sort()).toEqual(['a1', 'b1']);
  });
});

describe('the owner role switch', () => {
  it('runs an owner statement as portal_owner', async () => {
    expect(await new OwnerDb(fx.owner).run(currentUser)).toBe('portal_owner');
  });

  it('runs as portal_owner for a login that also holds portal_tenant', async () => {
    expect(await new OwnerDb(fx.dual).run(currentUser)).toBe('portal_owner');
  });

  it('lists every tenant for that login only through the owner role', async () => {
    const tenants = await new OwnerDb(fx.dual).listTenants();
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
  });
});
