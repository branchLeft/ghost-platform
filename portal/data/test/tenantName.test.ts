import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDb } from '../src/owner/index.js';
import {
  InvalidTenantNameError,
  TENANT_NAME_PATTERN,
  TenantNameTakenError,
  normaliseTenantName,
} from '../src/tenantName.js';
import { createFixture, rootMessage, type Fixture } from './helpers.js';

// Every name here is a made-up placeholder, never a real customer's.
const ID_ONE = '81000000-0000-4000-8000-000000000001';
const ID_TWO = '81000000-0000-4000-8000-000000000002';
const ID_THREE = '81000000-0000-4000-8000-000000000003';

let fx: Fixture;
let owner: OwnerDb;

beforeAll(async () => {
  fx = await createFixture();
  owner = new OwnerDb(fx.owner);
});

afterAll(async () => {
  await fx.close();
});

async function namesStored(): Promise<string[]> {
  return owner.run(async (tx) => {
    const result = await tx.execute(
      sql`SELECT tenant_name FROM portal.tenant_register WHERE tenant_name IS NOT NULL ORDER BY 1`
    );
    return result.rows.map((row) => String(row['tenant_name']));
  });
}

describe('normalising a tenant name', () => {
  it('folds case and padding the way the slug is folded', () => {
    expect(normaliseTenantName('Placeholder-One')).toBe('placeholder-one');
    expect(normaliseTenantName('  placeholder-one  ')).toBe('placeholder-one');
    expect(normaliseTenantName('PLACEHOLDER-ONE')).toBe(normaliseTenantName('placeholder-one'));
  });

  it.each([
    undefined,
    null,
    '',
    'ab',
    'a'.repeat(27),
    '-placeholder',
    'placeholder-',
    'place--holder',
    '1placeholder',
    'place_holder',
    'place holder',
    'placeholder.example',
    '../placeholder',
    7,
  ])('refuses %j and does not echo it', (value) => {
    let thrown: unknown;
    try {
      normaliseTenantName(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidTenantNameError);
    if (typeof value === 'string' && value !== '') {
      expect((thrown as Error).message).not.toContain(value);
    }
  });

  it('agrees with the provisioning workflow on the shape of a name', () => {
    expect(TENANT_NAME_PATTERN).toBe('^[a-z][a-z0-9-]{1,24}[a-z0-9]$');
  });
});

describe('the control plane refuses a taken name when it accepts the sign-up', () => {
  it('accepts the first sign-up and stores the normalised name', async () => {
    await owner.registerTenant({
      tenantId: ID_ONE,
      zitadelOrgId: 'org-name-one',
      kind: 'REAL',
      tenantName: 'Placeholder-One',
    });
    expect(await namesStored()).toEqual(['placeholder-one']);
  });

  it('refuses a second sign-up under the same name, whatever its case or padding', async () => {
    for (const spelling of ['placeholder-one', 'PLACEHOLDER-ONE', ' Placeholder-One ']) {
      await expect(
        owner.registerTenant({
          tenantId: ID_TWO,
          zitadelOrgId: 'org-name-two',
          kind: 'REAL',
          tenantName: spelling,
        })
      ).rejects.toThrow(TenantNameTakenError);
    }
    // Nothing was registered by the refused attempts.
    expect((await owner.listTenants()).map((t) => t.tenantId)).not.toContain(ID_TWO);
    expect(await namesStored()).toEqual(['placeholder-one']);
  });

  it('says nothing about who holds the name', async () => {
    const refused = await owner
      .registerTenant({
        tenantId: ID_TWO,
        zitadelOrgId: 'org-name-two',
        kind: 'REAL',
        tenantName: 'placeholder-one',
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    expect(refused).toBeInstanceOf(TenantNameTakenError);
    expect(refused?.message).not.toContain('placeholder-one');
    expect(refused?.message).not.toContain(ID_ONE);
  });

  it('accepts a different name', async () => {
    await owner.registerTenant({
      tenantId: ID_TWO,
      zitadelOrgId: 'org-name-two',
      kind: 'REAL',
      tenantName: 'placeholder-two',
    });
    expect(await namesStored()).toEqual(['placeholder-one', 'placeholder-two']);
  });

  it('refuses a name that is not a slug before any statement', async () => {
    await expect(
      owner.registerTenant({
        tenantId: ID_THREE,
        zitadelOrgId: 'org-name-three',
        kind: 'REAL',
        tenantName: 'not a slug',
      })
    ).rejects.toThrow(InvalidTenantNameError);
    expect((await owner.listTenants()).map((t) => t.tenantId)).not.toContain(ID_THREE);
  });

  it('lets any number of nameless demo slots in, since a demo has no customer name', async () => {
    await owner.registerTenant({ tenantId: ID_THREE, zitadelOrgId: 'org-demo-a', kind: 'DEMO' });
    await owner.registerTenant({
      tenantId: '81000000-0000-4000-8000-000000000004',
      zitadelOrgId: 'org-demo-b',
      kind: 'DEMO',
    });
    expect((await owner.listTenants()).filter((t) => t.kind === 'DEMO').length).toBeGreaterThan(1);
  });
});

describe('the table itself refuses a taken name, even to a statement that skips the code', () => {
  it('refuses a duplicate by the unique constraint', async () => {
    const message = await owner
      .run((tx) =>
        tx.execute(
          sql`INSERT INTO portal.tenant_register (tenant_id, zitadel_org_id, kind, tenant_name)
              VALUES ('81000000-0000-4000-8000-000000000005', 'org-raw-dup', 'REAL', 'placeholder-one')`
        )
      )
      .then(
        () => 'did not fail',
        (error: unknown) => rootMessage(error)
      );
    expect(message).toMatch(/tenant_register_tenant_name_unique/);
  });

  it.each(['Placeholder-One', 'ab', 'bad name', '-bad', 'bad-'])(
    'refuses %j by the shape check',
    async (name) => {
      const message = await owner
        .run((tx) =>
          tx.execute(
            sql`INSERT INTO portal.tenant_register (tenant_id, zitadel_org_id, kind, tenant_name)
                VALUES ('81000000-0000-4000-8000-000000000006', 'org-raw-shape', 'REAL', ${name})`
          )
        )
        .then(
          () => 'did not fail',
          (error: unknown) => rootMessage(error)
        );
      expect(message).toMatch(/tenant_register_tenant_name_shape/);
    }
  );
});
