import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantRegister } from '../src/schema.js';
import { TenantBindingChangedError, TenantDb, bindTenant, type Tx } from '../src/tenant/index.js';
import { note } from './fixtureSchema.js';
import {
  ORG_B,
  TENANT_A,
  TENANT_B,
  createFixture,
  rejection,
  rootMessage,
  type Fixture,
} from './helpers.js';

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

interface Attempt {
  name: string;
  /** The login the run is made through: the plain tenant login, or the one holding both roles. */
  login: 'tenant' | 'dual';
  /** The statement that tries to leave the bound tenant. */
  rebind: (tx: Tx) => Promise<unknown>;
  /** Whether the other tenant's rows are then readable from `note`; the register shows them regardless. */
  readsNote: boolean;
  /** Whether a row for the other tenant can then be written. */
  writesOther: boolean;
}

const ATTEMPTS: Attempt[] = [
  {
    name: 'set_config of the tenant binding',
    login: 'tenant',
    rebind: (tx) => tx.execute(sql`SELECT set_config('portal.tenant_id', ${TENANT_B}, true)`),
    readsNote: true,
    writesOther: true,
  },
  {
    name: 'SET LOCAL of the tenant binding',
    login: 'tenant',
    rebind: (tx) => tx.execute(sql.raw(`SET LOCAL portal.tenant_id = '${TENANT_B}'`)),
    readsNote: true,
    writesOther: true,
  },
  {
    name: 'binding an organisation beside the tenant',
    login: 'tenant',
    rebind: (tx) => tx.execute(sql.raw(`SET LOCAL portal.organisation_id = '${ORG_B}'`)),
    readsNote: false,
    writesOther: false,
  },
  {
    name: 'RESET ROLE on a login that bypasses row security',
    login: 'dual',
    rebind: (tx) => tx.execute(sql`RESET ROLE`),
    readsNote: true,
    writesOther: true,
  },
  {
    name: 'SET LOCAL ROLE NONE on a login that bypasses row security',
    login: 'dual',
    rebind: (tx) => tx.execute(sql`SET LOCAL ROLE NONE`),
    readsNote: true,
    writesOther: true,
  },
  {
    name: 'SET ROLE NONE on a login that bypasses row security',
    login: 'dual',
    rebind: (tx) => tx.execute(sql`SET ROLE NONE`),
    readsNote: true,
    writesOther: true,
  },
  {
    name: 'SET LOCAL ROLE to the owner role on a login that holds it',
    login: 'dual',
    rebind: (tx) => tx.execute(sql`SET LOCAL ROLE portal_owner`),
    readsNote: true,
    writesOther: false,
  },
];

async function notesFor(body: string): Promise<number> {
  const rows = await fx.admin.query('SELECT 1 FROM portal_test.note WHERE body = $1', [body]);
  return rows.rowCount ?? 0;
}

describe('code inside a tenant unit of work cannot leave the bound tenant', () => {
  it.each(ATTEMPTS)('refuses $name', async (attempt) => {
    const db = new TenantDb(attempt.login === 'tenant' ? fx.tenant : fx.dual);
    const before = `before: ${attempt.name}`;
    const after = `after: ${attempt.name}`;
    const seenInNote: string[] = [];
    const seenInRegister: string[] = [];

    const error = await rejection(
      db.run(bindTenant(TENANT_A), async (tx) => {
        await tx.insert(note).values({ tenantId: TENANT_A, body: before });
        await attempt.rebind(tx);
        seenInNote.push(...(await tx.select().from(note)).map((r) => r.body));
        seenInRegister.push(...(await tx.select().from(tenantRegister)).map((r) => r.tenantId));
        if (attempt.writesOther) {
          await tx.insert(note).values({ tenantId: TENANT_B, body: after });
        }
        return seenInNote;
      })
    );

    // The control: the attempt really did reach the other tenant inside the unit
    // of work, so the refusal below is the only thing that stopped it.
    expect(seenInRegister).toContain(TENANT_B);
    if (attempt.readsNote) expect(seenInNote).toContain('b1');

    // The run is refused by name, and nothing it read is returned to the caller.
    expect(error).toBeInstanceOf(TenantBindingChangedError);

    // The writes made before and after the attempt went with the transaction.
    expect(await notesFor(before)).toBe(0);
    expect(await notesFor(after)).toBe(0);
  });

  it('refuses a run that leaves the tenant role on the plain tenant login, which loses its rights', async () => {
    const db = new TenantDb(fx.tenant);
    const error = await rejection(
      db.run(bindTenant(TENANT_A), async (tx) => {
        await tx.insert(note).values({ tenantId: TENANT_A, body: 'before: reset role' });
        await tx.execute(sql`RESET ROLE`);
      })
    );
    expect(error).toBeInstanceOf(TenantBindingChangedError);
    expect(rootMessage(error)).toMatch(/permission denied/);
    expect(await notesFor('before: reset role')).toBe(0);
  });

  it('refuses a run that swallows a failed statement and leaves the transaction aborted', async () => {
    const db = new TenantDb(fx.tenant);
    const error = await rejection(
      db.run(bindTenant(TENANT_A), async (tx) => {
        await tx.insert(note).values({ tenantId: TENANT_A, body: 'before: aborted' });
        await tx.execute(sql`SELECT 1 / 0`).catch(() => undefined);
      })
    );
    expect(error).toBeInstanceOf(TenantBindingChangedError);
    expect(rootMessage(error)).toMatch(/current transaction is aborted/);
    expect(await notesFor('before: aborted')).toBe(0);
  });

  it('refuses through every tenant-facing method, since they all use run', async () => {
    const db = new TenantDb(fx.dual);
    const error = await rejection(
      db.run(bindTenant(TENANT_A), (tx) => tx.execute(sql`RESET ROLE`))
    );
    expect(error).toBeInstanceOf(TenantBindingChangedError);
    // The pooled connection is clean afterwards: the next run is bound as it should be.
    expect((await db.ownRegistration(bindTenant(TENANT_A)))?.tenantId).toBe(TENANT_A);
  });
});

describe('legitimate work is unchanged', () => {
  it('returns the work result and commits its writes', async () => {
    const db = new TenantDb(fx.tenant);
    const rows = await db.run(bindTenant(TENANT_A), async (tx) => {
      await tx.insert(note).values({ tenantId: TENANT_A, body: 'kept' });
      return tx.select().from(note);
    });
    expect(rows.map((r) => r.body).sort()).toEqual(['a1', 'kept']);
    expect(await notesFor('kept')).toBe(1);
  });

  it('lets work recover from a failed statement inside a savepoint', async () => {
    const db = new TenantDb(fx.tenant);
    const rows = await db.run(bindTenant(TENANT_A), async (tx) => {
      await tx.transaction((inner) => inner.execute(sql`SELECT 1 / 0`)).catch(() => undefined);
      return tx.select().from(note);
    });
    expect(rows.map((r) => r.body)).toContain('a1');
  });

  it('accepts a tenant that has no register row', async () => {
    const stranger = bindTenant('33333333-3333-4333-8333-333333333333');
    const rows = await new TenantDb(fx.tenant).run(stranger, (tx) => tx.select().from(note));
    expect(rows).toEqual([]);
  });

  it('still rolls back and rethrows the work error as it was', async () => {
    const db = new TenantDb(fx.tenant);
    await expect(
      db.run(bindTenant(TENANT_A), async (tx) => {
        await tx.insert(note).values({ tenantId: TENANT_A, body: 'never' });
        throw new Error('abandon');
      })
    ).rejects.toThrow('abandon');
    expect(await notesFor('never')).toBe(0);
  });
});
