import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { OwnerDb } from '../src/owner/index.js';
import { professionalEnquiry } from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const PERMISSION_DENIED = '42501';

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

/** The database's SQLSTATE for a refused statement, or undefined when it ran. */
async function refusedWith(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
  } catch (error) {
    return readDatabaseError(error)?.code ?? 'not a database error';
  }
  return undefined;
}

describe('the Professional enquiry count', () => {
  it('starts at zero before any enquiry is sent', async () => {
    expect(await owner.countProfessionalEnquiries()).toBe(0);
  });

  it('counts one row for each enquiry the bound tenant records, across tenants', async () => {
    await tenant.recordProfessionalEnquiry(bindTenant(TENANT_A));
    await tenant.recordProfessionalEnquiry(bindTenant(TENANT_A));
    await tenant.recordProfessionalEnquiry(bindTenant(TENANT_B));
    expect(await owner.countProfessionalEnquiries()).toBe(3);
  });

  it('files each row under the bound tenant, with no text', async () => {
    const rows = await fixture.adminDb.select().from(professionalEnquiry);
    expect(rows.map((row) => row.tenantId).sort()).toEqual([TENANT_A, TENANT_A, TENANT_B].sort());
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(['enquiryId', 'recordedAt', 'tenantId']);
  });

  it('refuses a tenant that files a row for another tenant', async () => {
    const attempt = tenant.run(bindTenant(TENANT_B), (tx) =>
      tx.insert(professionalEnquiry).values({ tenantId: TENANT_A })
    );
    expect(await refusedWith(attempt)).toBe(PERMISSION_DENIED);
    expect(await owner.countProfessionalEnquiries()).toBe(3);
  });

  it('gives a tenant no read of the table, its own rows included', async () => {
    const attempt = tenant.run(bindTenant(TENANT_A), (tx) => tx.select().from(professionalEnquiry));
    expect(await refusedWith(attempt)).toBe(PERMISSION_DENIED);
  });
});
