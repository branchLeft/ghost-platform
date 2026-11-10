import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import { OwnerDb } from '../src/owner/index.js';
import * as schema from '../src/schema.js';
import {
  InvalidSupportReadingError,
  SUPPORT_READING_FRESH_SECONDS,
  deriveSupportAccessView,
} from '../src/supportAccess.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';
import {
  READING_POLICY_OPEN,
  READING_TENANT_WRITE,
  REQUEST_CHECK_OPEN,
  REQUEST_INSERT_ANY_STATUS,
  REQUEST_TENANT_REWRITE,
  REQUEST_TENANT_STATUS_WRITE,
  columnsOf,
  privilegesOf,
  setRequestStatus,
  whileLoosened,
} from './supportAccessAdmin.js';

const T0 = new Date('2026-11-10T12:00:00Z');
const DEADLINE = new Date('2026-11-10T16:00:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await owner.recordSupportAccess(
    TENANT_A,
    { state: 'open', lane: 'consented', grantedAt: T0, deadline: DEADLINE },
    T0
  );
  await owner.recordSupportAccess(
    TENANT_B,
    { state: 'closed', lane: null, grantedAt: null, deadline: null },
    T0
  );
});

afterAll(async () => {
  await fixture.close();
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

const PERMISSION_DENIED = '42501';
const CHECK_VIOLATION = '23514';

describe('deriveSupportAccessView: unknown, never closed, when the reading is not believed', () => {
  const fresh = { state: 'closed', deadlineAt: null, observedAt: T0 };

  it('has no reading: unknown', () => {
    expect(deriveSupportAccessView(null, T0)).toEqual({
      state: 'unknown',
      deadline: null,
      observedAt: null,
    });
  });

  it('shows a fresh open reading with its deadline', () => {
    expect(
      deriveSupportAccessView({ ...fresh, state: 'open', deadlineAt: DEADLINE }, at(60))
    ).toEqual({ state: 'open', deadline: DEADLINE, observedAt: T0 });
  });

  it('shows a fresh closed reading, with no deadline', () => {
    expect(deriveSupportAccessView({ ...fresh, deadlineAt: DEADLINE }, at(60))).toEqual({
      state: 'closed',
      deadline: null,
      observedAt: T0,
    });
  });

  it('believes a reading up to the limit and not a second past it', () => {
    expect(deriveSupportAccessView(fresh, at(SUPPORT_READING_FRESH_SECONDS)).state).toBe('closed');
    expect(deriveSupportAccessView(fresh, at(SUPPORT_READING_FRESH_SECONDS + 1)).state).toBe(
      'unknown'
    );
  });

  it('shows a stale open reading as unknown, without its deadline', () => {
    const stale = { ...fresh, state: 'open', deadlineAt: DEADLINE };
    expect(deriveSupportAccessView(stale, at(SUPPORT_READING_FRESH_SECONDS + 1))).toEqual({
      state: 'unknown',
      deadline: null,
      observedAt: T0,
    });
  });

  it('shows a reading dated ahead of the clock as unknown', () => {
    expect(deriveSupportAccessView(fresh, at(-(SUPPORT_READING_FRESH_SECONDS + 1))).state).toBe(
      'unknown'
    );
  });

  it('shows a state outside the closed list as unknown', () => {
    expect(deriveSupportAccessView({ ...fresh, state: 'locked' }, T0).state).toBe('unknown');
  });
});

describe('the support-access tables are isolated like every tenant table', () => {
  it('passes the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it("gives tenant A its own reading and never B's", async () => {
    const own = await tenant.ownSupportAccess(bindTenant(TENANT_A), at(60));
    expect(own).toEqual({ state: 'open', deadline: DEADLINE, observedAt: T0 });
    const rows = await tenant.run(bindTenant(TENANT_A), (tx) =>
      tx.select().from(schema.supportAccessReading)
    );
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it("gives tenant B its own reading and nothing of A's", async () => {
    const own = await tenant.ownSupportAccess(bindTenant(TENANT_B), at(60));
    expect(own.state).toBe('closed');
    const rows = await tenant.run(bindTenant(TENANT_B), (tx) =>
      tx.select().from(schema.supportAccessReading)
    );
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_B]);
  });

  it('refuses a cross-tenant read: A bound, B named, nothing comes back', async () => {
    const rows = await tenant.run(bindTenant(TENANT_A), (tx) =>
      tx
        .select()
        .from(schema.supportAccessReading)
        .where(sql`${schema.supportAccessReading.tenantId} = ${TENANT_B}`)
    );
    expect(rows).toEqual([]);
  });

  it('shows a tenant with no reading as unknown, never closed', async () => {
    await fixture.adminDb.delete(schema.supportAccessReading);
    const own = await tenant.ownSupportAccess(bindTenant(TENANT_B), at(60));
    expect(own).toEqual({ state: 'unknown', deadline: null, observedAt: null });
    await owner.recordSupportAccess(
      TENANT_A,
      { state: 'open', lane: 'consented', grantedAt: T0, deadline: DEADLINE },
      T0
    );
    await owner.recordSupportAccess(
      TENANT_B,
      { state: 'closed', lane: null, grantedAt: null, deadline: null },
      T0
    );
  });
});

describe('a tenant cannot write a reading', () => {
  it('refuses an insert, an update and a delete, its own row or another tenant’s', async () => {
    for (const id of [TENANT_A, TENANT_B]) {
      expect(
        await refusedWith(
          tenant.run(bindTenant(TENANT_A), (tx) =>
            tx.insert(schema.supportAccessReading).values({
              tenantId: id,
              state: 'closed',
              observedAt: T0,
            })
          )
        )
      ).toBe(PERMISSION_DENIED);
    }
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.update(schema.supportAccessReading).set({ state: 'closed' })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) => tx.delete(schema.supportAccessReading))
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('refuses a state or lane the table does not know, even from the table’s own owner', async () => {
    expect(
      await refusedWith(
        fixture.adminDb
          .insert(schema.supportAccessReading)
          .values({ tenantId: TENANT_A, state: 'bogus', observedAt: T0 })
      )
    ).toBe(CHECK_VIOLATION);
    await expect(
      fixture.adminDb
        .update(schema.supportAccessReading)
        .set({ state: 'bogus' })
        .where(sql`${schema.supportAccessReading.tenantId} = ${TENANT_A}`)
    ).rejects.toThrow();
    await expect(
      fixture.adminDb
        .update(schema.supportAccessReading)
        .set({ lane: 'bogus' })
        .where(sql`${schema.supportAccessReading.tenantId} = ${TENANT_A}`)
    ).rejects.toThrow();
  });
});

describe('the request: a row and nothing else', () => {
  it('holds a tenant and a time and no text of any kind', async () => {
    const columns = await columnsOf(fixture, 'support_access_request');
    expect(columns).toEqual([
      { column_name: 'requested_at', data_type: 'timestamp with time zone' },
      { column_name: 'status', data_type: 'text' },
      { column_name: 'tenant_id', data_type: 'uuid' },
    ]);
  });

  it('records the bound tenant’s request with the database clock, once', async () => {
    const before = Date.now();
    expect(await tenant.requestSupportAccess(bindTenant(TENANT_A))).toBe(true);
    expect(await tenant.requestSupportAccess(bindTenant(TENANT_A))).toBe(false);
    const own = await tenant.ownSupportRequest(bindTenant(TENANT_A));
    expect(own).not.toBeNull();
    expect(own!.status).toBe('open');
    expect(Math.abs(own!.requestedAt.getTime() - before)).toBeLessThan(60_000);
    const rows = await fixture.adminDb.select().from(schema.supportAccessRequest);
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it('shows a tenant its own request and not another’s', async () => {
    expect(await tenant.ownSupportRequest(bindTenant(TENANT_B))).toBeNull();
  });

  it('refuses a row for another tenant: A bound, B named', async () => {
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.insert(schema.supportAccessRequest).values({ tenantId: TENANT_B })
        )
      )
    ).toBe(PERMISSION_DENIED);
    const rows = await fixture.adminDb.select().from(schema.supportAccessRequest);
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it('refuses a tenant changing or withdrawing a request', async () => {
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.update(schema.supportAccessRequest).set({ requestedAt: at(1) })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) => tx.delete(schema.supportAccessRequest))
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('refuses a tenant filing its request already dealt with', async () => {
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_B), (tx) =>
          tx
            .insert(schema.supportAccessRequest)
            .values({ tenantId: TENANT_B, status: 'dealt_with' })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(await tenant.ownSupportRequest(bindTenant(TENANT_B))).toBeNull();
  });

  it('refuses a tenant changing the status of its own request', async () => {
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.update(schema.supportAccessRequest).set({ status: 'dealt_with' })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect((await tenant.ownSupportRequest(bindTenant(TENANT_A)))!.status).toBe('open');
  });

  it('holds the status to open and dealt_with, whoever writes it', async () => {
    expect(
      await refusedWith(
        fixture.adminDb
          .update(schema.supportAccessRequest)
          .set({ status: 'closed' })
          .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_A}`)
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('gives the tenant role INSERT and SELECT on the request table and nothing more', async () => {
    expect(await privilegesOf(fixture, 'portal_tenant', 'support_access_request')).toEqual([
      'INSERT',
      'SELECT',
    ]);
  });
});

describe('the owner side', () => {
  it('lists every request, open ones first and oldest first, with no paging', async () => {
    await fixture.adminDb
      .insert(schema.supportAccessRequest)
      .values({ tenantId: TENANT_B, requestedAt: new Date(Date.now() + 3_600_000) });
    const queue = await owner.listSupportRequests();
    expect(queue.map((row) => [row.tenantId, row.status])).toEqual([
      [TENANT_A, 'open'],
      [TENANT_B, 'open'],
    ]);
    expect(queue[0]!.requestedAt.getTime()).toBeLessThan(queue[1]!.requestedAt.getTime());
    expect(await owner.markSupportRequestDealtWith(TENANT_A)).toBe(true);
    const after = await owner.listSupportRequests();
    expect(after.map((row) => [row.tenantId, row.status])).toEqual([
      [TENANT_B, 'open'],
      [TENANT_A, 'dealt_with'],
    ]);
    await setRequestStatus(fixture, TENANT_A, 'open');
  });

  it('marks a request dealt with once, and shows the tenant the word', async () => {
    expect(await owner.markSupportRequestDealtWith(TENANT_A)).toBe(true);
    expect(await owner.markSupportRequestDealtWith(TENANT_A)).toBe(false);
    expect((await tenant.ownSupportRequest(bindTenant(TENANT_A)))!.status).toBe('dealt_with');
    await setRequestStatus(fixture, TENANT_A, 'open');
  });

  it('marks nothing for a tenant with no request, or an id that is not one', async () => {
    expect(await owner.markSupportRequestDealtWith('33333333-3333-4333-8333-333333333333')).toBe(
      false
    );
    await expect(owner.markSupportRequestDealtWith('not-a-tenant')).rejects.toThrow();
  });

  it('marks only the named tenant’s request', async () => {
    await fixture.adminDb
      .insert(schema.supportAccessRequest)
      .values({ tenantId: TENANT_B })
      .onConflictDoNothing();
    expect(await owner.markSupportRequestDealtWith(TENANT_B)).toBe(true);
    expect((await tenant.ownSupportRequest(bindTenant(TENANT_A)))!.status).toBe('open');
    expect((await tenant.ownSupportRequest(bindTenant(TENANT_B)))!.status).toBe('dealt_with');
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
  });

  it('keeps a dealt-with request: a tenant cannot file a second row, and nothing deletes one', async () => {
    expect(await owner.markSupportRequestDealtWith(TENANT_A)).toBe(true);
    expect(await tenant.requestSupportAccess(bindTenant(TENANT_A))).toBe(false);
    expect((await tenant.ownSupportRequest(bindTenant(TENANT_A)))!.status).toBe('dealt_with');
    await setRequestStatus(fixture, TENANT_A, 'open');
  });

  it('holds SELECT and UPDATE and no DELETE for the owner role on the queue', async () => {
    expect(await privilegesOf(fixture, 'portal_owner', 'support_access_request')).toEqual([
      'SELECT',
      'UPDATE',
    ]);
  });

  it('replaces a tenant’s reading in place', async () => {
    await owner.recordSupportAccess(
      TENANT_A,
      { state: 'closed', lane: null, grantedAt: null, deadline: null },
      at(300)
    );
    const own = await tenant.ownSupportAccess(bindTenant(TENANT_A), at(360));
    expect(own).toEqual({ state: 'closed', deadline: null, observedAt: at(300) });
  });

  it('refuses a state or lane outside the closed lists before it reaches the table', async () => {
    const bad = [
      { state: 'locked', lane: null, grantedAt: null, deadline: null },
      { state: 'open', lane: 'standing', grantedAt: null, deadline: null },
    ];
    for (const reading of bad) {
      await expect(
        owner.recordSupportAccess(TENANT_A, reading as never, T0)
      ).rejects.toBeInstanceOf(InvalidSupportReadingError);
    }
  });

  it('refuses a reading for a tenant that is not registered, and an id that is not one', async () => {
    await expect(
      owner.recordSupportAccess(
        '33333333-3333-4333-8333-333333333333',
        { state: 'closed', lane: null, grantedAt: null, deadline: null },
        T0
      )
    ).rejects.toThrow();
    await expect(
      owner.recordSupportAccess(
        'not-a-tenant',
        { state: 'closed', lane: null, grantedAt: null, deadline: null },
        T0
      )
    ).rejects.toThrow();
  });
});

/**
 * The controls above are only worth something if their tests can see a leak.
 * Each case here loosens one database control for the length of the case,
 * shows the matching probe now gets through, and restores it in a `finally`.
 */
describe('sabotage: each probe goes red when its control is removed', () => {
  it('a policy that lets every row through shows tenant B’s reading to tenant A', async () => {
    await whileLoosened(fixture, READING_POLICY_OPEN, async () => {
      const rows = await tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.select().from(schema.supportAccessReading)
      );
      expect(rows.map((row) => row.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    });
    const rows = await tenant.run(bindTenant(TENANT_A), (tx) =>
      tx.select().from(schema.supportAccessReading)
    );
    expect(rows.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it('a check that lets every row through lets tenant A file tenant B’s request', async () => {
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
    await whileLoosened(fixture, REQUEST_CHECK_OPEN, async () => {
      await tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.insert(schema.supportAccessRequest).values({ tenantId: TENANT_B })
      );
      const rows = await fixture.adminDb.select().from(schema.supportAccessRequest);
      expect(rows.map((row) => row.tenantId)).toContain(TENANT_B);
    });
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.insert(schema.supportAccessRequest).values({ tenantId: TENANT_B })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('a write grant to the tenant role would let it write the reading the page shows', async () => {
    await whileLoosened(fixture, READING_TENANT_WRITE, async () => {
      await tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.update(schema.supportAccessReading).set({ state: 'closed' })
      );
      expect((await tenant.ownSupportAccess(bindTenant(TENANT_A), at(310))).state).toBe('closed');
    });
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.update(schema.supportAccessReading).set({ state: 'open' })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('an update grant would let a tenant rewrite its request', async () => {
    await whileLoosened(fixture, REQUEST_TENANT_REWRITE, async () => {
      await tenant.run(bindTenant(TENANT_A), (tx) => tx.delete(schema.supportAccessRequest));
      expect(await tenant.ownSupportRequest(bindTenant(TENANT_A))).toBeNull();
    });
    await tenant.requestSupportAccess(bindTenant(TENANT_A));
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) => tx.delete(schema.supportAccessRequest))
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('an update grant on the status column would let a tenant mark its own request dealt with', async () => {
    await whileLoosened(fixture, REQUEST_TENANT_STATUS_WRITE, async () => {
      await tenant.run(bindTenant(TENANT_A), (tx) =>
        tx.update(schema.supportAccessRequest).set({ status: 'dealt_with' })
      );
      expect((await tenant.ownSupportRequest(bindTenant(TENANT_A)))!.status).toBe('dealt_with');
    });
    await setRequestStatus(fixture, TENANT_A, 'open');
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_A), (tx) =>
          tx.update(schema.supportAccessRequest).set({ status: 'dealt_with' })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('a lifted insert restriction would let a tenant file a request already dealt with', async () => {
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
    await whileLoosened(fixture, REQUEST_INSERT_ANY_STATUS, async () => {
      await tenant.run(bindTenant(TENANT_B), (tx) =>
        tx.insert(schema.supportAccessRequest).values({ tenantId: TENANT_B, status: 'dealt_with' })
      );
      expect((await tenant.ownSupportRequest(bindTenant(TENANT_B)))!.status).toBe('dealt_with');
    });
    await fixture.adminDb
      .delete(schema.supportAccessRequest)
      .where(sql`${schema.supportAccessRequest.tenantId} = ${TENANT_B}`);
    expect(
      await refusedWith(
        tenant.run(bindTenant(TENANT_B), (tx) =>
          tx
            .insert(schema.supportAccessRequest)
            .values({ tenantId: TENANT_B, status: 'dealt_with' })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });
});
