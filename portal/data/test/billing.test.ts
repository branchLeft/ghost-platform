import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidBillingReferenceError,
  InvalidPaymentStateError,
  PAYMENT_STATES,
  deriveBillingView,
  parseBillingReference,
  parsePaymentState,
} from '../src/billing.js';
import { readDatabaseError } from '../src/databaseError.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import { OwnerDb, TenantNotBillableError, TenantNotRegisteredError } from '../src/owner/index.js';
import * as schema from '../src/schema.js';
import { tenantBilling } from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

// TENANT_A is a real tenant and TENANT_B a demo slot in the fixture. Two more
// real tenants are registered here, so a control case has a neighbour.
const REAL_2 = '33333333-3333-4333-8333-333333333333';
const REAL_3 = '44444444-4444-4444-8444-444444444444';
const UNREGISTERED = '55555555-5555-4555-8555-555555555555';

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await owner.registerTenant({ tenantId: REAL_2, zitadelOrgId: 'org-real-2', kind: 'REAL' });
  await owner.registerTenant({ tenantId: REAL_3, zitadelOrgId: 'org-real-3', kind: 'REAL' });
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
const NOT_NULL_VIOLATION = '23502';

/** The pause that lets the database clock tick between two transactions. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('the billing reference is opaque', () => {
  it.each([
    'INV-2026-0042',
    'cus_Nf3kQ9x',
    'a1b',
    'ref:2026.11/x'.replace('/', '_'),
    'X'.padEnd(64, 'y'),
  ])('accepts %s', (value) => {
    expect(parseBillingReference(value)).toBe(value);
  });

  it.each([
    ['two characters', 'ab'],
    ['sixty-five characters', 'a'.repeat(65)],
    ['a space', 'INV 2026'],
    ['an e-mail address', 'someone@example.org'],
    ['a URL', 'https://pay.example.org/i/1'],
    ['a leading separator', '-INV-2026'],
    ['an empty string', ''],
    ['a card number', '4242424242424242'],
    ['a card number in groups', '4242-4242-4242-4242'],
    ['a card number with dots', '4242.4242.4242.4242'],
    ['twelve digits', '123456789012'],
  ])('refuses %s without echoing it', (_name, value) => {
    expect(() => parseBillingReference(value)).toThrow(InvalidBillingReferenceError);
    try {
      parseBillingReference(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value === '' ? '\u0000' : value);
    }
  });

  it('refuses a value that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['INV-1']]) {
      expect(() => parseBillingReference(value)).toThrow(InvalidBillingReferenceError);
    }
  });

  it('accepts a long invoice number that is not card-like', () => {
    expect(parseBillingReference('2026-11-0012')).toBe('2026-11-0012');
    expect(parseBillingReference('INV-4242424242424242')).toBe('INV-4242424242424242');
  });
});

describe('the payment state is a closed list', () => {
  it('names unpaid, paid and overdue', () => {
    expect([...PAYMENT_STATES]).toEqual(['unpaid', 'paid', 'overdue']);
  });

  it.each(['', 'PAID', 'Paid', 'late', 'refunded', ' paid', undefined, null, 1])(
    'refuses %s, never defaulting it',
    (value) => {
      expect(() => parsePaymentState(value)).toThrow(InvalidPaymentStateError);
    }
  );

  it('refuses a stored state outside the list instead of showing it', () => {
    expect(() =>
      deriveBillingView({
        tenantId: TENANT_A,
        billingReference: null,
        paymentState: 'settled',
        stateChangedAt: new Date(),
      })
    ).toThrow(InvalidPaymentStateError);
  });
});

describe("the owner sets a real tenant's payment state", () => {
  it('has no record until the owner makes one', async () => {
    expect(await owner.billingOf(TENANT_A)).toBeNull();
    expect(await tenant.ownBilling(bindTenant(TENANT_A))).toBeNull();
  });

  it('creates the record with the state given and no reference', async () => {
    const view = await owner.setPaymentState(TENANT_A, 'unpaid');
    expect(view).toMatchObject({
      tenantId: TENANT_A,
      billingReference: null,
      paymentState: 'unpaid',
    });
    expect(view.stateChangedAt).toBeInstanceOf(Date);
    expect(await owner.billingOf(TENANT_A)).toEqual(view);
  });

  it('moves the state clock when the state changes and not when it is repeated', async () => {
    const first = await owner.setPaymentState(REAL_2, 'overdue');
    await tick();
    const repeated = await owner.setPaymentState(REAL_2, 'overdue');
    expect(repeated.stateChangedAt).toEqual(first.stateChangedAt);
    await tick();
    const paid = await owner.setPaymentState(REAL_2, 'paid');
    expect(paid.paymentState).toBe('paid');
    expect(paid.stateChangedAt.getTime()).toBeGreaterThan(first.stateChangedAt.getTime());
  });

  it('refuses a state outside the list before any statement runs', async () => {
    await expect(owner.setPaymentState(TENANT_A, 'settled')).rejects.toBeInstanceOf(
      InvalidPaymentStateError
    );
    expect((await owner.billingOf(TENANT_A))!.paymentState).toBe('unpaid');
  });

  it('refuses a tenant that is not registered', async () => {
    await expect(owner.setPaymentState(UNREGISTERED, 'paid')).rejects.toBeInstanceOf(
      TenantNotRegisteredError
    );
    expect(await owner.billingOf(UNREGISTERED)).toBeNull();
  });

  it('refuses a demo slot: it pays nothing', async () => {
    await expect(owner.setPaymentState(TENANT_B, 'paid')).rejects.toBeInstanceOf(
      TenantNotBillableError
    );
    await expect(owner.setBillingReference(TENANT_B, 'INV-1000')).rejects.toBeInstanceOf(
      TenantNotBillableError
    );
    expect(await owner.billingOf(TENANT_B)).toBeNull();
  });

  it('refuses an id that is not a tenant id', async () => {
    await expect(owner.setPaymentState('not-a-uuid', 'paid')).rejects.toThrow(/tenant id/);
    await expect(owner.billingOf('not-a-uuid')).rejects.toThrow(/tenant id/);
  });
});

describe('the owner records a billing reference', () => {
  it('creates an unpaid record when there is none', async () => {
    const view = await owner.setBillingReference(REAL_3, 'INV-2026-0042');
    expect(view).toMatchObject({
      tenantId: REAL_3,
      billingReference: 'INV-2026-0042',
      paymentState: 'unpaid',
    });
  });

  it('keeps the payment state and its clock when the reference is replaced', async () => {
    const before = await owner.setPaymentState(REAL_3, 'overdue');
    await tick();
    const after = await owner.setBillingReference(REAL_3, 'cus_Nf3kQ9x');
    expect(after.billingReference).toBe('cus_Nf3kQ9x');
    expect(after.paymentState).toBe('overdue');
    expect(after.stateChangedAt).toEqual(before.stateChangedAt);
  });

  it('keeps the reference when the state changes', async () => {
    const view = await owner.setPaymentState(REAL_3, 'paid');
    expect(view.billingReference).toBe('cus_Nf3kQ9x');
    await owner.setPaymentState(REAL_3, 'overdue');
  });

  it('refuses a card number, an e-mail address and free text, and stores nothing', async () => {
    for (const value of [
      '4242 4242 4242 4242',
      '4242-4242-4242-4242',
      'a@b.example',
      'pays by card',
    ]) {
      await expect(owner.setBillingReference(REAL_3, value)).rejects.toBeInstanceOf(
        InvalidBillingReferenceError
      );
    }
    expect((await owner.billingOf(REAL_3))!.billingReference).toBe('cus_Nf3kQ9x');
  });

  it('clears the reference when given null', async () => {
    await owner.setBillingReference(REAL_3, null);
    expect((await owner.billingOf(REAL_3))!.billingReference).toBeNull();
    await owner.setBillingReference(REAL_3, 'cus_Nf3kQ9x');
  });
});

describe('the console lists overdue tenants', () => {
  it('lists every overdue tenant and only those, the longest overdue first', async () => {
    await owner.setPaymentState(TENANT_A, 'overdue');
    await tick();
    // REAL_3 went overdue before TENANT_A did; REAL_2 is paid.
    const overdue = await owner.listOverdue();
    expect(overdue.map((row) => row.tenantId)).toEqual([REAL_3, TENANT_A]);
    expect(overdue.every((row) => row.paymentState === 'overdue')).toBe(true);
  });

  it('drops a tenant from the list once it has paid, and leaves the others', async () => {
    await owner.setPaymentState(REAL_3, 'paid');
    expect((await owner.listOverdue()).map((row) => row.tenantId)).toEqual([TENANT_A]);
    await owner.setPaymentState(REAL_3, 'overdue');
  });

  it('lists every record, by tenant id', async () => {
    const all = await owner.listBilling();
    expect(all.map((row) => row.tenantId)).toEqual([TENANT_A, REAL_2, REAL_3].sort());
  });
});

describe("a tenant reads its own billing record and nobody else's", () => {
  it('sees its own reference and state', async () => {
    expect(await tenant.ownBilling(bindTenant(REAL_3))).toMatchObject({
      tenantId: REAL_3,
      billingReference: 'cus_Nf3kQ9x',
      paymentState: 'overdue',
    });
  });

  it("control case: another tenant's record is not visible to it", async () => {
    const rows = await tenant.run(bindTenant(REAL_2), (tx) => tx.select().from(tenantBilling));
    expect(rows.map((row) => row.tenantId)).toEqual([REAL_2]);
  });

  it('cannot mark itself paid, write, or delete: it holds SELECT alone', async () => {
    const scope = bindTenant(REAL_3);
    expect(
      await refusedWith(
        tenant.run(scope, (tx) =>
          tx
            .update(tenantBilling)
            .set({ paymentState: 'paid' })
            .where(sql`true`)
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(
      await refusedWith(
        tenant.run(scope, (tx) =>
          tx.insert(tenantBilling).values({ tenantId: REAL_3, paymentState: 'paid' })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(await refusedWith(tenant.run(scope, (tx) => tx.delete(tenantBilling)))).toBe(
      PERMISSION_DENIED
    );
    expect((await owner.billingOf(REAL_3))!.paymentState).toBe('overdue');
  });
});

describe('the table refuses what the code would, when the code is skipped', () => {
  const insertAs = (reference: string | null, state: string): Promise<unknown> =>
    fixture.adminDb.execute(
      sql`INSERT INTO portal.tenant_billing (tenant_id, billing_reference, payment_state)
          VALUES (${UNREGISTERED}::uuid, ${reference}, ${state})`
    );

  it('refuses a card-number-like reference', async () => {
    expect(await refusedWith(insertAs('4242424242424242', 'paid'))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insertAs('4242-4242-4242-4242', 'paid'))).toBe(CHECK_VIOLATION);
  });

  it('refuses a reference with a space or an @', async () => {
    expect(await refusedWith(insertAs('has space', 'paid'))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insertAs('a@b.example', 'paid'))).toBe(CHECK_VIOLATION);
  });

  it('refuses a state outside the list, and an absent one', async () => {
    expect(await refusedWith(insertAs('INV-1000', 'settled'))).toBe(CHECK_VIOLATION);
    expect(
      await refusedWith(
        fixture.adminDb.execute(
          sql`INSERT INTO portal.tenant_billing (tenant_id) VALUES (${UNREGISTERED}::uuid)`
        )
      )
    ).toBe(NOT_NULL_VIOLATION);
  });
});

describe('what the table holds', () => {
  it('has exactly the four columns: no card, bank, name, address or free text', async () => {
    const result = await fixture.admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'tenant_billing' ORDER BY column_name`
    );
    expect(result.rows.map((row: { column_name: string }) => row.column_name)).toEqual([
      'billing_reference',
      'payment_state',
      'state_changed_at',
      'tenant_id',
    ]);
  });

  it('is isolated by tenant like every other tenant table', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });
});
