import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import { OwnerDb } from '../src/owner/index.js';
import * as schema from '../src/schema.js';
import {
  ERASURE_RESIDUAL_AROUND_DAYS,
  ERASURE_RESIDUAL_REASON,
  RESIDUAL_WINDOW,
  deriveErasureView,
} from '../src/tenantErasure.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';
import { columnsOf, privilegesOf } from './supportAccessAdmin.js';

const T0 = new Date('2026-11-10T12:00:00Z');
const PERMISSION_DENIED = '42501';
const CHECK_VIOLATION = '23514';

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fixture.adminDb.delete(schema.tenantErasureRequest);
});

/** The database's SQLSTATE for a refused statement. */
async function refusedWith(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
  } catch (error) {
    return readDatabaseError(error)?.code ?? 'not a database error';
  }
  return undefined;
}

interface Loosening {
  readonly apply: readonly SQL[];
  readonly restore: readonly SQL[];
}

/** Runs `probe` with one control removed, and puts it back whatever the probe does. */
async function whileLoosened(loosening: Loosening, probe: () => Promise<void>): Promise<void> {
  for (const statement of loosening.apply) await fixture.adminDb.execute(statement);
  try {
    await probe();
  } finally {
    for (const statement of loosening.restore) await fixture.adminDb.execute(statement);
  }
}

const TENANT_UPDATE: Loosening = {
  apply: [sql`GRANT UPDATE ON portal.tenant_erasure_request TO portal_tenant`],
  restore: [sql`REVOKE UPDATE ON portal.tenant_erasure_request FROM portal_tenant`],
};

const INSERT_ANY_STATUS: Loosening = {
  apply: [
    sql`ALTER POLICY tenant_insert_requested ON portal.tenant_erasure_request WITH CHECK (true)`,
  ],
  restore: [
    sql`ALTER POLICY tenant_insert_requested ON portal.tenant_erasure_request WITH CHECK (status = 'requested' AND key_destroyed_at IS NULL)`,
  ],
};

const MOMENT_CHECK_DROPPED: Loosening = {
  apply: [
    sql`ALTER TABLE portal.tenant_erasure_request DROP CONSTRAINT tenant_erasure_request_destroyed_moment`,
  ],
  restore: [
    sql`ALTER TABLE portal.tenant_erasure_request ADD CONSTRAINT tenant_erasure_request_destroyed_moment CHECK ((status = 'requested' AND key_destroyed_at IS NULL) OR (status = 'key_destroyed' AND key_destroyed_at IS NOT NULL))`,
  ],
};

describe('deriveErasureView: only what the record proves', () => {
  it('has no row: none', () => {
    expect(deriveErasureView(null)).toEqual({ state: 'none' });
  });

  it('a requested row is requested: no key moment, no residual window', () => {
    const view = deriveErasureView({ status: 'requested', requestedAt: T0, keyDestroyedAt: null });
    expect(view).toEqual({ state: 'requested', requestedAt: T0 });
    expect(JSON.stringify(view)).not.toContain('residual');
  });

  it('a key_destroyed row with its moment carries the honest window', () => {
    const view = deriveErasureView({
      status: 'key_destroyed',
      requestedAt: T0,
      keyDestroyedAt: new Date('2026-11-11T09:00:00Z'),
    });
    expect(view).toEqual({
      state: 'key_destroyed',
      requestedAt: T0,
      keyDestroyedAt: new Date('2026-11-11T09:00:00Z'),
      residual: { aroundDays: 46, upperBoundDays: null, reason: 'ANCHOR_DUMP_NEVER_PRUNED' },
    });
  });

  it('control case: key_destroyed without its moment is shown as requested, never as destroyed', () => {
    expect(
      deriveErasureView({ status: 'key_destroyed', requestedAt: T0, keyDestroyedAt: null })
    ).toEqual({ state: 'requested', requestedAt: T0 });
  });

  it('control case: a status outside the closed list is shown as requested', () => {
    for (const status of ['', 'erased', 'deleted', 'KEY_DESTROYED', 'done']) {
      expect(
        deriveErasureView({ status, requestedAt: T0, keyDestroyedAt: new Date('2026-11-11') }).state
      ).toBe('requested');
    }
  });

  it('the residual window has no upper bound and says why', () => {
    expect(RESIDUAL_WINDOW.upperBoundDays).toBeNull();
    expect(RESIDUAL_WINDOW.aroundDays).toBe(ERASURE_RESIDUAL_AROUND_DAYS);
    expect(RESIDUAL_WINDOW.aroundDays).toBe(46);
    expect(RESIDUAL_WINDOW.reason).toBe(ERASURE_RESIDUAL_REASON);
    expect(Object.keys(RESIDUAL_WINDOW).sort()).toEqual(['aroundDays', 'reason', 'upperBoundDays']);
  });
});

describe('a tenant requests its own erasure', () => {
  it('records one row with the database clock, status requested and no key moment', async () => {
    expect(await tenant.requestOwnErasure(bindTenant(TENANT_A))).toBe(true);
    const rows = await fixture.adminDb.select().from(schema.tenantErasureRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_A,
      status: 'requested',
      keyDestroyedAt: null,
    });
    expect(rows[0]!.requestedAt).toBeInstanceOf(Date);
    const view = await tenant.ownErasure(bindTenant(TENANT_A));
    expect(view.state).toBe('requested');
  });

  it('a tenant that has not asked has nothing: none', async () => {
    expect(await tenant.ownErasure(bindTenant(TENANT_A))).toEqual({ state: 'none' });
  });

  it('a second request records nothing and keeps the first moment', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const first = (await fixture.adminDb.select().from(schema.tenantErasureRequest))[0]!;
    expect(await tenant.requestOwnErasure(bindTenant(TENANT_A))).toBe(false);
    const rows = await fixture.adminDb.select().from(schema.tenantErasureRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestedAt).toEqual(first.requestedAt);
  });

  it("shows tenant B nothing of tenant A's request, and files only for the bound tenant", async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    expect(await tenant.ownErasure(bindTenant(TENANT_B))).toEqual({ state: 'none' });
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_B), (tx) =>
          tx.insert(schema.tenantErasureRequest).values({ tenantId: TENANT_A })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('passes the isolation check every tenant table must', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('holds no column that can carry text', async () => {
    const columns = await columnsOf(fixture, 'tenant_erasure_request');
    expect(columns.map((c) => `${c.column_name}:${c.data_type}`)).toEqual([
      'key_destroyed_at:timestamp with time zone',
      'requested_at:timestamp with time zone',
      'status:text',
      'tenant_id:uuid',
    ]);
  });

  it('gives the tenant role insert and select alone; the owner role select and update alone', async () => {
    expect(await privilegesOf(fixture, 'portal_tenant', 'tenant_erasure_request')).toEqual([
      'INSERT',
      'SELECT',
    ]);
    expect(await privilegesOf(fixture, 'portal_owner', 'tenant_erasure_request')).toEqual([
      'SELECT',
      'UPDATE',
    ]);
  });
});

describe('the tenant can never mark its own key destroyed', () => {
  it('refuses a tenant filing a request that already says the key is destroyed', async () => {
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx
            .insert(schema.tenantErasureRequest)
            .values({ tenantId: TENANT_A, status: 'key_destroyed', keyDestroyedAt: T0 })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(await tenant.ownErasure(bindTenant(TENANT_A))).toEqual({ state: 'none' });
  });

  it('refuses a tenant updating or deleting its own request', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx
            .update(schema.tenantErasureRequest)
            .set({ status: 'key_destroyed', keyDestroyedAt: T0 })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) => tx.delete(schema.tenantErasureRequest))
      )
    ).toBe(PERMISSION_DENIED);
    expect((await tenant.ownErasure(bindTenant(TENANT_A))).state).toBe('requested');
  });

  it('holds the status to the closed list and ties the moment to the status, whoever writes', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const set = (values: { status: string; keyDestroyedAt: Date | null }) =>
      fixture.adminDb
        .update(schema.tenantErasureRequest)
        .set(values)
        .where(sql`${schema.tenantErasureRequest.tenantId} = ${TENANT_A}`);
    expect(await refusedWith(set({ status: 'erased', keyDestroyedAt: T0 }))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(set({ status: 'key_destroyed', keyDestroyedAt: null }))).toBe(
      CHECK_VIOLATION
    );
    expect(await refusedWith(set({ status: 'requested', keyDestroyedAt: T0 }))).toBe(
      CHECK_VIOLATION
    );
  });

  it('sabotage: an update grant would let a tenant declare its own key destroyed; revoked, it cannot', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await whileLoosened(TENANT_UPDATE, async () => {
      await tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.update(schema.tenantErasureRequest).set({ status: 'key_destroyed', keyDestroyedAt: T0 })
      );
      expect((await tenant.ownErasure(bindTenant(TENANT_A))).state).toBe('key_destroyed');
    });
    await fixture.adminDb
      .update(schema.tenantErasureRequest)
      .set({ status: 'requested', keyDestroyedAt: null });
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx
            .update(schema.tenantErasureRequest)
            .set({ status: 'key_destroyed', keyDestroyedAt: T0 })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect((await tenant.ownErasure(bindTenant(TENANT_A))).state).toBe('requested');
  });

  it('sabotage: a lifted insert restriction would let a tenant file an already-destroyed row; restored, it cannot', async () => {
    await whileLoosened(INSERT_ANY_STATUS, async () => {
      await tenant.run(bindTenant(TENANT_B), (tx) =>
        tx
          .insert(schema.tenantErasureRequest)
          .values({ tenantId: TENANT_B, status: 'key_destroyed', keyDestroyedAt: T0 })
      );
      expect((await tenant.ownErasure(bindTenant(TENANT_B))).state).toBe('key_destroyed');
    });
    await fixture.adminDb.delete(schema.tenantErasureRequest);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_B), (tx) =>
          tx
            .insert(schema.tenantErasureRequest)
            .values({ tenantId: TENANT_B, status: 'key_destroyed', keyDestroyedAt: T0 })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('sabotage: with the moment check dropped a destroyed row can lack its moment, and is still shown as requested', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await whileLoosened(MOMENT_CHECK_DROPPED, async () => {
      await fixture.adminDb
        .update(schema.tenantErasureRequest)
        .set({ status: 'key_destroyed', keyDestroyedAt: null });
      expect((await tenant.ownErasure(bindTenant(TENANT_A))).state).toBe('requested');
      await fixture.adminDb
        .update(schema.tenantErasureRequest)
        .set({ status: 'requested', keyDestroyedAt: null });
    });
  });
});

describe('the owner records a destroyed key', () => {
  it('moves a requested row to key_destroyed with the database clock, once', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    expect(await owner.recordKeyDestroyed(TENANT_A)).toBe(true);
    const view = await tenant.ownErasure(bindTenant(TENANT_A));
    expect(view.state).toBe('key_destroyed');
    if (view.state !== 'key_destroyed') throw new Error('unreachable');
    expect(view.keyDestroyedAt.getTime()).toBeGreaterThanOrEqual(view.requestedAt.getTime());
    expect(view.residual).toEqual({
      aroundDays: 46,
      upperBoundDays: null,
      reason: 'ANCHOR_DUMP_NEVER_PRUNED',
    });
    // A second recording changes nothing: the first moment stands.
    expect(await owner.recordKeyDestroyed(TENANT_A)).toBe(false);
    const again = await tenant.ownErasure(bindTenant(TENANT_A));
    expect(again).toEqual(view);
  });

  it('control case: a tenant that never asked cannot be recorded as erased', async () => {
    expect(await owner.recordKeyDestroyed(TENANT_B)).toBe(false);
    expect(await fixture.adminDb.select().from(schema.tenantErasureRequest)).toHaveLength(0);
    expect(await tenant.ownErasure(bindTenant(TENANT_B))).toEqual({ state: 'none' });
  });

  it("control case: recording tenant A's key leaves tenant B's request requested", async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    await owner.recordKeyDestroyed(TENANT_A);
    expect((await tenant.ownErasure(bindTenant(TENANT_B))).state).toBe('requested');
  });

  it('refuses an id that is not a tenant id before any statement runs', async () => {
    await expect(owner.recordKeyDestroyed('not-a-uuid')).rejects.toThrow();
  });

  it('lists waiting requests first, then recorded ones, each with its view', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    await owner.recordKeyDestroyed(TENANT_A);
    const list = await owner.listErasureRequests();
    expect(list.map((r) => [r.tenantId, r.view.state])).toEqual([
      [TENANT_B, 'requested'],
      [TENANT_A, 'key_destroyed'],
    ]);
  });
});
