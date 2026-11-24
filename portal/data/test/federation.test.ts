import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  FederationNotAvailableError,
  InvalidFederationFormError,
  TenantDb,
  bindTenant,
  parseFederationForm,
} from '../src/tenant/index.js';
import * as schema from '../src/schema.js';
import {
  TENANT_A,
  TENANT_B,
  createFixture,
  rejection,
  rootMessage,
  type Fixture,
} from './helpers.js';

const NOW = new Date('2026-11-24T10:00:00Z');
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);

let fixture: Fixture;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  tenant = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

afterEach(async () => {
  // Every test starts with both switches off, as the migration leaves them.
  await fixture.adminDb
    .update(schema.tenantRegister)
    .set({ federationEnabled: false, federationUpdatedBy: null, federationUpdatedAt: null });
});

const register = async (tenantId: string) =>
  (
    await fixture.adminDb
      .select()
      .from(schema.tenantRegister)
      .where(eq(schema.tenantRegister.tenantId, tenantId))
  )[0];

describe('the federation switch in the register', () => {
  it('is off for every tenant before anyone has set it', async () => {
    expect(await tenant.ownFederation(scopeA)).toBe(false);
    expect((await register(TENANT_A))?.federationEnabled).toBe(false);
  });

  it('a real tenant turns it on and off, and the change records who and when', async () => {
    await tenant.saveFederation(scopeA, { enabled: true, updatedBy: 'admin-a' }, NOW);
    expect(await tenant.ownFederation(scopeA)).toBe(true);
    const row = await register(TENANT_A);
    expect(row?.federationUpdatedBy).toBe('admin-a');
    expect(row?.federationUpdatedAt?.toISOString()).toBe(NOW.toISOString());

    await tenant.saveFederation(scopeA, { enabled: false, updatedBy: 'admin-a' }, NOW);
    expect(await tenant.ownFederation(scopeA)).toBe(false);
  });

  it('one tenant never reads or sets another tenant’s switch', async () => {
    await tenant.saveFederation(scopeA, { enabled: true, updatedBy: 'admin-a' }, NOW);
    expect(await tenant.ownFederation(scopeB)).toBe(false);
    expect((await register(TENANT_B))?.federationEnabled).toBe(false);
  });
});

describe('a demo slot cannot set federation', () => {
  it('the storage call is refused and stores nothing', async () => {
    const error = await rejection(
      tenant.saveFederation(scopeB, { enabled: true, updatedBy: 'admin-b' }, NOW)
    );
    expect(error).toBeInstanceOf(FederationNotAvailableError);
    expect((await register(TENANT_B))?.federationEnabled).toBe(false);
    expect((await register(TENANT_B))?.federationUpdatedBy).toBeNull();
  });

  it('the database refuses a DEMO row with federation on, to a statement that skips the code', async () => {
    // Sabotage target: drop the database check from the migration in a scratch
    // run and this test goes red.
    const message = rootMessage(
      await rejection(
        fixture.adminDb
          .update(schema.tenantRegister)
          .set({ federationEnabled: true })
          .where(eq(schema.tenantRegister.tenantId, TENANT_B))
      )
    );
    expect(message).toMatch(/tenant_register_federation_demo_off/);
    expect((await register(TENANT_B))?.federationEnabled).toBe(false);
  });
});

describe('parsing the posted form', () => {
  it('reads an absent field as off and the checked field as on', () => {
    expect(parseFederationForm(new URLSearchParams())).toBe(false);
    expect(parseFederationForm(new URLSearchParams('federation.enabled=1'))).toBe(true);
  });

  it('refuses any other field, a repeat, or any other value', () => {
    expect(() => parseFederationForm(new URLSearchParams('kind=DEMO'))).toThrow(
      InvalidFederationFormError
    );
    expect(() => parseFederationForm(new URLSearchParams('federation.enabled=yes'))).toThrow(
      InvalidFederationFormError
    );
    expect(() =>
      parseFederationForm(new URLSearchParams('federation.enabled=1&federation.enabled=1'))
    ).toThrow(InvalidFederationFormError);
  });
});
