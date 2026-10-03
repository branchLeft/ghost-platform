import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import { desiredState, ROLE_OWNER, ROLE_TENANT_ADMIN } from '../src/desired.js';
import { ConfigError } from '../src/errors.js';
import { reconcile } from '../src/reconcile.js';
import { FakeZitadel, HOSTNAMES, TWO_TENANTS } from './fakes.js';

const desired = (tenants = TWO_TENANTS) =>
  desiredState(validateConfig({ hostnames: HOSTNAMES, tenants }));

describe('reconcile', () => {
  it('creates two tenant organisations, the owner organisation, one project, two applications, and two grants', async () => {
    const fake = new FakeZitadel();
    const result = await reconcile(fake, desired());
    expect([...fake.orgs.keys()].sort()).toEqual([
      'branchleft-owner',
      'tenant-alpha',
      'tenant-beta-two',
    ]);
    expect(fake.projects.size).toBe(1);
    expect(fake.apps.size).toBe(2);
    expect(fake.grants.size).toBe(2);
    expect(result.drift).toBe(false);
    expect(result.actions.every((a) => a.status === 'created')).toBe(true);
  });

  it('changes nothing on a second run', async () => {
    const fake = new FakeZitadel();
    const first = await reconcile(fake, desired());
    const writesAfterFirst = fake.writes;
    const second = await reconcile(fake, desired());
    expect(fake.writes).toBe(writesAfterFirst);
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
    expect(second.outputs).toEqual(first.outputs);
  });

  it('adds only the new tenant when the list grows', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, desired());
    const before = fake.writes;
    await reconcile(fake, desired([...TWO_TENANTS, { slug: 'gamma', displayName: 'GAMMA' }]));
    expect(fake.writes - before).toBe(2);
    expect(fake.orgs.has('tenant-gamma')).toBe(true);
  });

  it('never removes a tenant that left the list', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, desired());
    await reconcile(fake, desired([TWO_TENANTS[0]!]));
    expect(fake.orgs.has('tenant-beta-two')).toBe(true);
  });

  it('returns two different client ids and an organisation id per tenant', async () => {
    const { outputs } = await reconcile(new FakeZitadel(), desired());
    expect(outputs.clientIds.console).not.toBe(outputs.clientIds.portal);
    expect(Object.keys(outputs.tenantOrgIds).sort()).toEqual(['alpha', 'beta-two']);
    expect(new Set(Object.values(outputs.tenantOrgIds)).size).toBe(2);
    expect(Object.values(outputs.tenantOrgIds)).not.toContain(outputs.ownerOrgId);
  });

  it('reports a redirect URI that was changed, and does not overwrite it', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, desired());
    const app = fake.apps.get('tenant-portal')!;
    fake.apps.set('tenant-portal', {
      ...app,
      redirectUris: ['https://elsewhere.example.test/auth/callback'],
    });
    const result = await reconcile(fake, desired());
    expect(result.drift).toBe(true);
    expect(result.actions.find((a) => a.status === 'drift')?.name).toBe('tenant-portal');
    expect(fake.apps.get('tenant-portal')?.redirectUris).toEqual([
      'https://elsewhere.example.test/auth/callback',
    ]);
  });

  it('reports a post-logout URI that was changed', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, desired());
    const app = fake.apps.get('owner-console')!;
    fake.apps.set('owner-console', { ...app, postLogoutRedirectUris: [] });
    expect((await reconcile(fake, desired())).drift).toBe(true);
  });

  it('reports a tenant grant that gained the owner role', async () => {
    const fake = new FakeZitadel();
    const { outputs } = await reconcile(fake, desired());
    const orgId = outputs.tenantOrgIds['alpha']!;
    fake.grants.set(orgId, { id: 'g', roleKeys: [ROLE_TENANT_ADMIN, ROLE_OWNER] });
    const result = await reconcile(fake, desired());
    expect(result.drift).toBe(true);
    expect(result.actions.find((a) => a.status === 'drift')?.detail).toContain('owner');
    expect(fake.grants.get(orgId)?.roleKeys).toContain(ROLE_OWNER);
  });

  it('creates a role that is missing from an existing project', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, desired());
    fake.roles.delete(ROLE_OWNER);
    const result = await reconcile(fake, desired());
    expect(result.actions.find((a) => a.kind === 'role' && a.name === ROLE_OWNER)?.status).toBe(
      'created'
    );
  });

  it('refuses a state that breaks an invariant before writing anything', async () => {
    const fake = new FakeZitadel();
    const s = desired();
    const bad = { ...s, grants: s.grants.map((g) => ({ ...g, roleKeys: [ROLE_OWNER] })) };
    await expect(reconcile(fake, bad)).rejects.toBeInstanceOf(ConfigError);
    expect(fake.writes).toBe(0);
  });

  it('fails when a grant names a tenant with no organisation', async () => {
    const fake = new FakeZitadel();
    const s = desired();
    const bad = { ...s, grants: [{ ...s.grants[0]!, slug: 'ghost' }, s.grants[1]!] };
    await expect(reconcile(fake, bad)).rejects.toThrow('no organisation id');
  });
});
