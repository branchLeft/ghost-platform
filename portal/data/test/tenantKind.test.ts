import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDb } from '../src/owner/index.js';
import { tenantRegister } from '../src/schema.js';
import {
  InvalidTenantKindError,
  TENANT_KINDS,
  TenantDb,
  TenantNotRegisteredError,
  bindTenant,
  parseTenantKind,
} from '../src/tenant/index.js';
import { ORG_A, ORG_B, TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let db: TenantDb;

beforeAll(async () => {
  fx = await createFixture();
  db = new TenantDb(fx.tenant);
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

const NEW_TENANT = '66666666-6666-4666-8666-666666666666';

describe('parsing a tenant kind', () => {
  it('accepts exactly the recognised kinds', () => {
    expect(TENANT_KINDS).toEqual(['REAL', 'DEMO']);
    expect(parseTenantKind('REAL')).toBe('REAL');
    expect(parseTenantKind('DEMO')).toBe('DEMO');
  });

  it.each([
    undefined,
    null,
    '',
    'real',
    'demo',
    'Real',
    ' REAL',
    'REAL ',
    'TENANT',
    1,
    {},
    ['REAL'],
  ])('refuses %j, and defaults to neither kind', (value) => {
    expect(() => parseTenantKind(value)).toThrow(InvalidTenantKindError);
  });
});

describe('the tenant reads its own kind from the register', () => {
  it('answers REAL for the real tenant and DEMO for the demo slot', async () => {
    expect(await db.ownKind(bindTenant(TENANT_A))).toBe('REAL');
    expect(await db.ownKind(bindTenant(TENANT_B))).toBe('DEMO');
  });

  it('carries the kind on its registration', async () => {
    expect(await db.ownRegistration(bindTenant(TENANT_A))).toMatchObject({
      tenantId: TENANT_A,
      zitadelOrgId: ORG_A,
      kind: 'REAL',
    });
    expect(await db.ownRegistration(bindTenant(TENANT_B))).toMatchObject({
      zitadelOrgId: ORG_B,
      kind: 'DEMO',
    });
  });

  it('throws, rather than answering either kind, for a scope with no register row', async () => {
    await expect(db.ownKind(bindTenant(NEW_TENANT))).rejects.toThrow(TenantNotRegisteredError);
  });

  it('cannot set or change its own kind', async () => {
    const promote = await dbMessage(
      db.run(bindTenant(TENANT_B), (tx) => tx.update(tenantRegister).set({ kind: 'REAL' }))
    );
    expect(promote).toMatch(/permission denied/);
    const insert = await dbMessage(
      db.run(bindTenant(NEW_TENANT), (tx) =>
        tx
          .insert(tenantRegister)
          .values({ tenantId: NEW_TENANT, zitadelOrgId: 'org-self', kind: 'REAL' })
      )
    );
    expect(insert).toMatch(/permission denied/);
    expect(await db.ownKind(bindTenant(TENANT_B))).toBe('DEMO');
  });
});

describe('the owner registers a tenant with a kind', () => {
  it('stores the kind it is given and lists it', async () => {
    const owner = new OwnerDb(fx.owner);
    await owner.registerTenant({ tenantId: NEW_TENANT, zitadelOrgId: 'org-new', kind: 'REAL' });
    const listed = (await owner.listTenants()).find((t) => t.tenantId === NEW_TENANT);
    expect(listed).toEqual({ tenantId: NEW_TENANT, zitadelOrgId: 'org-new', kind: 'REAL' });
    expect(await db.ownKind(bindTenant(NEW_TENANT))).toBe('REAL');
  });

  it.each([undefined, null, '', 'real', 'demo', 'OTHER'])(
    'refuses a kind of %j before any statement, registering nothing',
    async (kind) => {
      const owner = new OwnerDb(fx.owner);
      const id = '77777777-7777-4777-8777-777777777777';
      await expect(
        owner.registerTenant({ tenantId: id, zitadelOrgId: 'org-bad', kind } as never)
      ).rejects.toThrow(InvalidTenantKindError);
      expect((await owner.listTenants()).map((t) => t.tenantId)).not.toContain(id);
    }
  );
});

describe('the table refuses a bad kind even to a statement that skips the code', () => {
  const id = '88888888-8888-4888-8888-888888888888';

  it.each([null, 'real', 'demo', '', 'TENANT'])('refuses a direct insert of %j', async (kind) => {
    const message = await dbMessage(
      fx.adminDb
        .insert(tenantRegister)
        .values({ tenantId: id, zitadelOrgId: 'org-raw', kind: kind as never })
    );
    expect(message).toMatch(
      kind === null
        ? /null value in column "kind"/
        : /violates check constraint "tenant_register_kind_known"/
    );
  });

  it('refuses an insert that names no kind at all, as there is no default', async () => {
    const message = await dbMessage(
      fx.adminDb
        .insert(tenantRegister)
        .values({ tenantId: id, zitadelOrgId: 'org-nokind' } as never)
    );
    expect(message).toMatch(/null value in column "kind"/);
  });

  it('refuses an update of a stored kind to a bad one', async () => {
    const message = await dbMessage(
      fx.adminDb
        .update(tenantRegister)
        .set({ kind: 'real' as never })
        .where(eq(tenantRegister.tenantId, TENANT_B))
    );
    expect(message).toMatch(/violates check constraint "tenant_register_kind_known"/);
  });
});
