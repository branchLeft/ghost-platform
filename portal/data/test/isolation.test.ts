import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bind, connect, enterRole, type PortalDb } from '../src/db.js';
import { OwnerDb } from '../src/owner/index.js';
import { tenantRegister } from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { leaky, note } from './fixtureSchema.js';
import { ORG_A, ORG_B, TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let db: TenantDb;
let raw: PortalDb;

beforeAll(async () => {
  fx = await createFixture();
  db = new TenantDb(fx.tenant);
  raw = connect(fx.tenant);
  await fx.adminDb.insert(note).values([
    { tenantId: TENANT_A, body: 'a1' },
    { tenantId: TENANT_A, body: 'a2' },
    { tenantId: TENANT_B, body: 'b1' },
  ]);
  await fx.adminDb.insert(leaky).values([
    { tenantId: TENANT_A, body: 'a' },
    { tenantId: TENANT_B, body: 'b' },
  ]);
});

afterAll(async () => {
  await fx.close();
});

/** The database's own message: drizzle wraps it as the cause of "Failed query". */
async function dbMessage(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  return 'did not fail';
}

/** The tenant role with no tenant bound: what a missing binding looks like. */
function unbound<T>(
  work: Parameters<PortalDb['transaction']>[0] extends (tx: infer Tx) => unknown
    ? (tx: Tx) => Promise<T>
    : never
): Promise<T> {
  return raw.transaction(async (tx) => {
    await enterRole(tx, 'portal_tenant');
    return work(tx);
  });
}

describe('a query with no tenant bound', () => {
  it('fails at run time on the register', async () => {
    expect(await dbMessage(unbound((tx) => tx.select().from(tenantRegister)))).toMatch(
      /no tenant bound to the session/
    );
  });

  it('fails at run time on an isolated table', async () => {
    expect(await dbMessage(unbound((tx) => tx.select().from(note)))).toMatch(
      /no tenant bound to the session/
    );
  });

  it('is not rescued by an empty binding', async () => {
    const message = await dbMessage(
      unbound(async (tx) => {
        await bind(tx, 'portal.tenant_id', '');
        return tx.select().from(note);
      })
    );
    expect(message).toMatch(/no tenant bound to the session/);
  });

  it('cannot be written either', async () => {
    expect(
      await dbMessage(unbound((tx) => tx.insert(note).values({ tenantId: TENANT_B, body: 'x' })))
    ).toMatch(/no tenant bound to the session/);
  });
});

describe('a query with a tenant bound', () => {
  it('returns only that tenant on the register', async () => {
    expect(await db.ownRegistration(bindTenant(TENANT_A))).toEqual({
      tenantId: TENANT_A,
      zitadelOrgId: ORG_A,
    });
    expect(await db.ownRegistration(bindTenant(TENANT_B))).toEqual({
      tenantId: TENANT_B,
      zitadelOrgId: ORG_B,
    });
  });

  it('returns nothing for a tenant that is not in the register', async () => {
    const stranger = bindTenant('33333333-3333-4333-8333-333333333333');
    expect(await db.ownRegistration(stranger)).toBeNull();
  });

  it('returns only that tenant on an isolated table, whatever the statement asks for', async () => {
    const a = await db.run(bindTenant(TENANT_A), (tx) => tx.select().from(note));
    expect(a.map((r) => r.body).sort()).toEqual(['a1', 'a2']);
    const asked = await db.run(bindTenant(TENANT_A), async (tx) => {
      const rows = await tx.select().from(note);
      return rows.filter((r) => r.tenantId === TENANT_B);
    });
    expect(asked).toEqual([]);
  });

  it('refuses a write that names another tenant', async () => {
    const message = await dbMessage(
      db.run(bindTenant(TENANT_A), (tx) =>
        tx.insert(note).values({ tenantId: TENANT_B, body: 'planted' })
      )
    );
    expect(message).toMatch(/row-level security/);
  });

  it('accepts a write for the bound tenant, visible to that tenant only', async () => {
    await db.run(bindTenant(TENANT_B), (tx) =>
      tx.insert(note).values({ tenantId: TENANT_B, body: 'b2' })
    );
    const seenByA = await db.run(bindTenant(TENANT_A), (tx) => tx.select().from(note));
    expect(seenByA).toHaveLength(2);
    const seenByB = await db.run(bindTenant(TENANT_B), (tx) => tx.select().from(note));
    expect(seenByB.map((r) => r.body).sort()).toEqual(['b1', 'b2']);
  });

  it('rolls back a failed unit of work whole', async () => {
    await expect(
      db.run(bindTenant(TENANT_B), async (tx) => {
        await tx.insert(note).values({ tenantId: TENANT_B, body: 'never' });
        throw new Error('abandon');
      })
    ).rejects.toThrow('abandon');
    const rows = await db.run(bindTenant(TENANT_B), (tx) => tx.select().from(note));
    expect(rows.map((r) => r.body)).not.toContain('never');
  });

  it('cannot change the register, even for its own row', async () => {
    const message = await dbMessage(
      db.run(bindTenant(TENANT_A), (tx) => tx.update(tenantRegister).set({ zitadelOrgId: 'taken' }))
    );
    expect(message).toMatch(/permission denied/);
    expect(await db.ownRegistration(bindTenant(TENANT_A))).toMatchObject({ zitadelOrgId: ORG_A });
  });

  it('does not carry the binding to the next caller of a pooled connection', async () => {
    await db.ownRegistration(bindTenant(TENANT_A));
    expect(await dbMessage(unbound((tx) => tx.select().from(tenantRegister)))).toMatch(
      /no tenant bound to the session/
    );
  });

  it('cannot reach the owner role with raw statements', async () => {
    expect(
      await dbMessage(db.run(bindTenant(TENANT_A), (tx) => enterRole(tx, 'portal_owner')))
    ).toMatch(/permission denied to set role/);
  });
});

describe('resolving the session organisation', () => {
  it('binds the tenant that owns the organisation', async () => {
    const scope = await db.scopeForOrganisation(ORG_B);
    expect(scope?.tenantId).toBe(TENANT_B);
  });

  it('binds nothing for an unknown organisation', async () => {
    expect(await db.scopeForOrganisation('org-unknown')).toBeNull();
  });

  it('passes the organisation as data, never as SQL', async () => {
    expect(await db.scopeForOrganisation("' OR true --")).toBeNull();
  });

  it('reads one row at most, never the whole register', async () => {
    const rows = await raw.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.organisation_id', ORG_A);
      return tx.select().from(tenantRegister);
    });
    expect(rows.map((r) => r.tenantId)).toEqual([TENANT_A]);
  });

  it('opens nothing else: an organisation binding reads no tenant table', async () => {
    const rows = await raw.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.organisation_id', ORG_A);
      return tx.select().from(note);
    });
    expect(rows).toEqual([]);
  });
});

describe('the owner path', () => {
  it('lists every tenant', async () => {
    const tenants = await new OwnerDb(fx.owner).listTenants();
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it('registers a tenant, once per organisation', async () => {
    const owner = new OwnerDb(fx.owner);
    const id = '44444444-4444-4444-8444-444444444444';
    await owner.registerTenant({ tenantId: id, zitadelOrgId: 'org-c' });
    expect((await owner.listTenants()).map((t) => t.tenantId)).toContain(id);
    const duplicate = await dbMessage(
      owner.registerTenant({
        tenantId: '55555555-5555-4555-8555-555555555555',
        zitadelOrgId: 'org-c',
      })
    );
    expect(duplicate).toMatch(/duplicate key/);
    await expect(owner.registerTenant({ tenantId: 'nope', zitadelOrgId: 'org-d' })).rejects.toThrow(
      'tenant id is not a UUID'
    );
  });

  it('is not reachable from the tenant-facing connection', async () => {
    expect(await dbMessage(new OwnerDb(fx.tenant).listTenants())).toMatch(
      /permission denied to set role/
    );
  });
});

describe('the control case', () => {
  it('a table left without the isolation leaks every tenant to an unbound query', async () => {
    const rows = await unbound((tx) => tx.select().from(leaky));
    expect(rows.map((r) => r.body).sort()).toEqual(['a', 'b']);
  });
});
