import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTenantTablesIsolated } from '../src/migrate.js';
import { OwnerDb } from '../src/owner/index.js';
import {
  TenantDb,
  bindTenant,
  bindTenantFromOrganisation,
  ownRegistration,
} from '../src/tenant/index.js';
import { ORG_A, ORG_B, TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let db: TenantDb;

beforeAll(async () => {
  fx = await createFixture();
  db = new TenantDb(fx.tenant);
  await fx.admin.query(`
    CREATE TABLE portal.note (id serial PRIMARY KEY, tenant_id uuid NOT NULL, body text NOT NULL);
    SELECT portal.isolate_table('portal.note');
    GRANT SELECT, INSERT ON portal.note TO portal_tenant;
    GRANT USAGE ON SEQUENCE portal.note_id_seq TO portal_tenant;
  `);
  await fx.admin.query(
    'INSERT INTO portal.note (tenant_id, body) VALUES ($1, $2), ($1, $3), ($4, $5)',
    [TENANT_A, 'a1', 'a2', TENANT_B, 'b1']
  );
});

afterAll(async () => {
  await fx.close();
});

/** A statement as the tenant role with no tenant bound: what a missing binding looks like. */
async function unbound<T>(sql: string): Promise<T[]> {
  const client = await fx.tenant.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE portal_tenant');
    const { rows } = await client.query(sql);
    return rows as T[];
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('a query with no tenant bound', () => {
  it('fails at run time on the register', async () => {
    await expect(unbound('SELECT * FROM portal.tenant_register')).rejects.toThrow(
      'no tenant bound to the session'
    );
  });

  it('fails at run time on a table isolated with the helper', async () => {
    await expect(unbound('SELECT * FROM portal.note')).rejects.toThrow(
      'no tenant bound to the session'
    );
  });

  it('is not rescued by an empty binding', async () => {
    await expect(
      unbound("SELECT set_config('portal.tenant_id', '', true), * FROM portal.note")
    ).rejects.toThrow('no tenant bound to the session');
  });

  it('cannot be written either', async () => {
    await expect(
      unbound("INSERT INTO portal.note (tenant_id, body) VALUES ('" + TENANT_B + "', 'x')")
    ).rejects.toThrow('no tenant bound to the session');
  });
});

describe('a query with a tenant bound', () => {
  it('returns only that tenant on the register', async () => {
    expect(await ownRegistration(db, bindTenant(TENANT_A))).toEqual({
      tenantId: TENANT_A,
      zitadelOrgId: ORG_A,
    });
    expect(await ownRegistration(db, bindTenant(TENANT_B))).toEqual({
      tenantId: TENANT_B,
      zitadelOrgId: ORG_B,
    });
  });

  it('returns nothing for a tenant that is not in the register', async () => {
    const stranger = bindTenant('33333333-3333-4333-8333-333333333333');
    expect(await ownRegistration(db, stranger)).toBeNull();
  });

  it('returns only that tenant on an isolated table, whatever the statement asks for', async () => {
    const a = await db.run(
      bindTenant(TENANT_A),
      async (c) =>
        (await c.query<{ body: string }>('SELECT body FROM portal.note ORDER BY body')).rows
    );
    expect(a.map((r) => r.body)).toEqual(['a1', 'a2']);
    const asked = await db.run(
      bindTenant(TENANT_A),
      async (c) =>
        (await c.query('SELECT body FROM portal.note WHERE tenant_id = $1', [TENANT_B])).rows
    );
    expect(asked).toEqual([]);
  });

  it('refuses a write that names another tenant', async () => {
    await expect(
      db.run(bindTenant(TENANT_A), async (c) => {
        await c.query("INSERT INTO portal.note (tenant_id, body) VALUES ($1, 'planted')", [
          TENANT_B,
        ]);
      })
    ).rejects.toThrow(/row-level security/);
  });

  it('accepts a write for the bound tenant, visible to that tenant only', async () => {
    await db.run(bindTenant(TENANT_B), async (c) => {
      await c.query("INSERT INTO portal.note (tenant_id, body) VALUES ($1, 'b2')", [TENANT_B]);
    });
    const seenByA = await db.run(
      bindTenant(TENANT_A),
      async (c) => (await c.query('SELECT body FROM portal.note')).rows.length
    );
    expect(seenByA).toBe(2);
  });

  it('cannot change the register, even for its own row', async () => {
    await expect(
      db.run(bindTenant(TENANT_A), async (c) => {
        await c.query("UPDATE portal.tenant_register SET zitadel_org_id = 'taken'");
      })
    ).rejects.toThrow(/permission denied/);
  });

  it('does not carry the binding to the next caller of a pooled connection', async () => {
    await ownRegistration(db, bindTenant(TENANT_A));
    await expect(unbound('SELECT * FROM portal.tenant_register')).rejects.toThrow(
      'no tenant bound to the session'
    );
  });

  it('cannot reach the owner role with raw statements', async () => {
    await expect(
      db.run(bindTenant(TENANT_A), async (c) => {
        await c.query('SET LOCAL ROLE portal_owner');
      })
    ).rejects.toThrow(/permission denied to set role/);
  });
});

describe('resolving the session organisation', () => {
  it('binds the tenant that owns the organisation', async () => {
    const scope = await bindTenantFromOrganisation(fx.tenant, ORG_B);
    expect(scope?.tenantId).toBe(TENANT_B);
  });

  it('binds nothing for an unknown organisation', async () => {
    expect(await bindTenantFromOrganisation(fx.tenant, 'org-unknown')).toBeNull();
  });

  it('passes the organisation as data, never as SQL', async () => {
    expect(await bindTenantFromOrganisation(fx.tenant, "' OR true --")).toBeNull();
  });
});

describe('the owner path', () => {
  it('lists every tenant', async () => {
    const owner = new OwnerDb(fx.owner);
    const tenants = await owner.listTenants();
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it('registers a tenant, once per organisation', async () => {
    const owner = new OwnerDb(fx.owner);
    const id = '44444444-4444-4444-8444-444444444444';
    await owner.registerTenant({ tenantId: id, zitadelOrgId: 'org-c' });
    expect((await owner.listTenants()).map((t) => t.tenantId)).toContain(id);
    await expect(
      owner.registerTenant({
        tenantId: '55555555-5555-4555-8555-555555555555',
        zitadelOrgId: 'org-c',
      })
    ).rejects.toThrow(/duplicate key/);
    await expect(owner.registerTenant({ tenantId: 'nope', zitadelOrgId: 'org-d' })).rejects.toThrow(
      'tenant id is not a UUID'
    );
  });

  it('is not reachable from the tenant-facing connection', async () => {
    await expect(new OwnerDb(fx.tenant).listTenants()).rejects.toThrow(
      /permission denied to set role/
    );
  });
});

describe('the control case', () => {
  it('a table left without the isolation leaks every tenant to an unbound query', async () => {
    await fx.admin.query(`
      CREATE TABLE portal.leaky (tenant_id uuid NOT NULL, body text NOT NULL);
      GRANT SELECT ON portal.leaky TO portal_tenant;
      INSERT INTO portal.leaky VALUES ('${TENANT_A}', 'a'), ('${TENANT_B}', 'b');
    `);
    try {
      const rows = await unbound<{ body: string }>('SELECT body FROM portal.leaky');
      expect(rows.map((r) => r.body).sort()).toEqual(['a', 'b']);
      await expect(assertTenantTablesIsolated(fx.admin)).rejects.toThrow(/portal\.|leaky/);
    } finally {
      await fx.admin.query('DROP TABLE portal.leaky');
    }
    await expect(assertTenantTablesIsolated(fx.admin)).resolves.toBeUndefined();
  });
});
