import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { connect, enterRole, type Tx } from '../src/db.js';
import { OwnerDb } from '../src/owner/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import {
  demoStateEvent,
  documentVersion,
  healthReading,
  hostnameRegister,
  hostnameRetirement,
  moderationSetting,
  tenantRegister,
} from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let provisioner: ProvisionerDb;
let label: string;
let demoId: string;

const PERMISSION_DENIED = '42501';

beforeAll(async () => {
  fx = await createFixture();
  provisioner = new ProvisionerDb(fx.provisioner);
  demoId = randomUUID();
  await provisioner.beginDemo(demoId);
  await provisioner.transition(demoId, 'CLAIMED');
  label = await provisioner.allocateHostname(demoId);
  await provisioner.retireHostname(label);
}, 60000);

afterAll(async () => {
  await fx.close();
});

/** The SQLSTATE the database refused the work with, or `ok` when it ran. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return readDatabaseError(error)?.code ?? `no SQLSTATE: ${String(error)}`;
  }
}

const asProvisioner =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    provisioner.run(work);
const asOwner =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    new OwnerDb(fx.owner).run(work);
const asTenant =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    new TenantDb(fx.tenant).run(bindTenant(TENANT_A), work);

describe('the provisioner role writes the register and the events, insert only', () => {
  it('inserts into the register, the retirements and the events (the positive control)', async () => {
    const newDemo = randomUUID();
    const newLabel = 'qqqqqqqqqqqqqqqqqqqq';
    expect(
      await outcome(
        asProvisioner(async (tx) => {
          await tx
            .insert(demoStateEvent)
            .values({ demoId: newDemo, sequence: 1, toState: 'VERIFIED' });
          await tx.insert(hostnameRegister).values({ label: newLabel, demoId: newDemo });
          await tx.insert(hostnameRetirement).values({ label: newLabel });
        })
      )
    ).toBe('ok');
  });

  it('reads what it wrote', async () => {
    const rows = await provisioner.run((tx) =>
      tx.select().from(hostnameRegister).where(eq(hostnameRegister.label, label))
    );
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['the register', hostnameRegister, { demoId: randomUUID() }],
    ['the retirements', hostnameRetirement, { label: 'pppppppppppppppppppp' }],
    ['the events', demoStateEvent, { extensionDays: 0 }],
  ] as const)(
    'cannot update %s: SQLSTATE 42501, not a constraint or application error',
    async (_name, table, set) => {
      expect(
        await outcome(
          asProvisioner((tx) =>
            tx
              .update(table)
              .set(set as never)
              .where(sql`true`)
          )
        )
      ).toBe(PERMISSION_DENIED);
    }
  );

  it.each([
    ['the register', hostnameRegister],
    ['the retirements', hostnameRetirement],
    ['the events', demoStateEvent],
  ] as const)('cannot delete from %s: SQLSTATE 42501', async (_name, table) => {
    expect(await outcome(asProvisioner((tx) => tx.delete(table).where(sql`true`)))).toBe(
      PERMISSION_DENIED
    );
  });

  it('cannot truncate any of them', async () => {
    for (const name of ['hostname_register', 'hostname_retirement', 'demo_state_event']) {
      const code = await outcome(
        asProvisioner((tx) => tx.execute(sql.raw(`TRUNCATE portal.${name} CASCADE`)))
      );
      expect(code).toBe(PERMISSION_DENIED);
    }
  });

  it('leaves the rows it could not change exactly as they were', async () => {
    const stored = await fx.admin.query('SELECT 1 FROM portal.hostname_register WHERE label = $1', [
      label,
    ]);
    expect(stored.rowCount).toBe(1);
  });

  it('touches no other portal table', async () => {
    for (const table of [tenantRegister, healthReading, documentVersion, moderationSetting]) {
      expect(await outcome(asProvisioner((tx) => tx.select().from(table)))).toBe(PERMISSION_DENIED);
    }
  });
});

describe('no other role can change them either', () => {
  const tables = [
    ['the register', hostnameRegister, { demoId: randomUUID() }],
    ['the retirements', hostnameRetirement, { label: 'oooooooooooooooooooo' }],
    ['the events', demoStateEvent, { extensionDays: 0 }],
  ] as const;

  it.each(tables)(
    'the owner role cannot update, delete or insert into %s',
    async (_name, table, set) => {
      expect(
        await outcome(
          asOwner((tx) =>
            tx
              .update(table)
              .set(set as never)
              .where(sql`true`)
          )
        )
      ).toBe(PERMISSION_DENIED);
      expect(await outcome(asOwner((tx) => tx.delete(table).where(sql`true`)))).toBe(
        PERMISSION_DENIED
      );
      expect(
        await outcome(
          asOwner((tx) => tx.insert(hostnameRetirement).values({ label: 'nnnnnnnnnnnnnnnnnnnn' }))
        )
      ).toBe(PERMISSION_DENIED);
      expect(await outcome(asOwner((tx) => tx.select().from(table)))).toBe('ok');
    }
  );

  it.each(tables)('the tenant role cannot read, update or delete %s', async (_name, table, set) => {
    expect(await outcome(asTenant((tx) => tx.select().from(table)))).toBe(PERMISSION_DENIED);
    expect(
      await outcome(
        asTenant((tx) =>
          tx
            .update(table)
            .set(set as never)
            .where(sql`true`)
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(await outcome(asTenant((tx) => tx.delete(table).where(sql`true`)))).toBe(
      PERMISSION_DENIED
    );
  });
});

describe('the privilege tables, role by role, as the catalog holds them', () => {
  const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

  async function held(role: string, table: string): Promise<string[]> {
    const result = await fx.admin.query<{ privilege: string; held: boolean }>(
      `SELECT p AS privilege, has_table_privilege($1, $2, p) AS held FROM unnest($3::text[]) p`,
      [role, `portal.${table}`, PRIVILEGES]
    );
    return result.rows.filter((r) => r.held).map((r) => r.privilege);
  }

  it.each(['hostname_register', 'hostname_retirement', 'demo_state_event'])(
    'on %s: the provisioner holds SELECT and INSERT, the owner SELECT, the tenant nothing',
    async (table) => {
      expect(await held('portal_provisioner', table)).toEqual(['SELECT', 'INSERT']);
      expect(await held('portal_owner', table)).toEqual(['SELECT']);
      expect(await held('portal_tenant', table)).toEqual([]);
    }
  );
});

describe('the provisioner role and its login', () => {
  async function one(text: string, values: unknown[] = []): Promise<Record<string, unknown>> {
    return (await fx.admin.query(text, values)).rows[0] as Record<string, unknown>;
  }

  it('is NOLOGIN, cannot bypass row security and is no superuser', async () => {
    expect(
      await one(
        `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolinherit
           FROM pg_roles WHERE rolname = 'portal_provisioner'`
      )
    ).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
    });
  });

  it('has one login, a member of this role alone', async () => {
    const result = await fx.admin.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, r.rolname AS role
         FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
        WHERE m.rolname = 'portal_test_provisioner_login'`
    );
    expect(result.rows).toEqual([
      { member: 'portal_test_provisioner_login', role: 'portal_provisioner' },
    ]);
  });

  it('cannot assume the owner or the tenant role', async () => {
    const db = connect(fx.provisioner);
    for (const role of ['portal_owner', 'portal_tenant'] as const) {
      expect(await outcome(() => db.transaction((tx) => enterRole(tx, role)))).toBe(
        PERMISSION_DENIED
      );
    }
  });

  it('holds nothing as the bare login: every statement goes through the role switch', async () => {
    expect(await outcome(() => connect(fx.provisioner).select().from(hostnameRegister))).toBe(
      PERMISSION_DENIED
    );
  });

  it('is not reachable from the tenant or owner logins', async () => {
    for (const pool of [fx.tenant, fx.owner]) {
      expect(
        await outcome(() => connect(pool).transaction((tx) => enterRole(tx, 'portal_provisioner')))
      ).toBe(PERMISSION_DENIED);
    }
  });
});
