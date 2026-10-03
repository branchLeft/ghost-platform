import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import {
  assertInvariants,
  desiredState,
  OWNER_ORG_NAME,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
  tenantOrgName,
} from '../src/desired.js';
import type { DesiredState } from '../src/desired.js';
import { ConfigError } from '../src/errors.js';
import { HOSTNAMES, TWO_TENANTS } from './fakes.js';

const state = (): DesiredState =>
  desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: TWO_TENANTS }));

function refusal(mutated: DesiredState): readonly string[] {
  try {
    assertInvariants(mutated);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('desiredState', () => {
  it('derives one organisation per tenant, plus the owner organisation', () => {
    const s = state();
    expect(s.ownerOrgName).toBe(OWNER_ORG_NAME);
    expect(s.tenantOrgs.map((o) => o.name)).toEqual([
      tenantOrgName('alpha'),
      tenantOrgName('beta-two'),
    ]);
    expect(s.tenantOrgs.map((o) => o.name)).not.toContain(OWNER_ORG_NAME);
  });

  it('derives two applications with their own names, hostnames and redirect URIs', () => {
    const [a, b] = state().applications;
    expect(a?.name).not.toBe(b?.name);
    expect(a?.redirectUris).toEqual([`https://${HOSTNAMES.console}/auth/callback`]);
    expect(b?.redirectUris).toEqual([`https://${HOSTNAMES.portal}/auth/callback`]);
    expect(a?.requiredRole).toBe(ROLE_OWNER);
    expect(b?.requiredRole).toBe(ROLE_TENANT_ADMIN);
  });

  it('grants each tenant the tenant role only', () => {
    for (const grant of state().grants) expect(grant.roleKeys).toEqual([ROLE_TENANT_ADMIN]);
  });

  it('follows the configured hostnames and nothing else', () => {
    const moved = desiredState(
      validateConfig({ hostnames: { ...HOSTNAMES, portal: 'other.example.test' }, tenants: [] })
    );
    expect(moved.applications[1]?.redirectUris).toEqual([
      'https://other.example.test/auth/callback',
    ]);
  });
});

describe('assertInvariants', () => {
  it('passes the derived state', () => {
    expect(() => assertInvariants(state())).not.toThrow();
  });

  it('refuses one application, or three', () => {
    const s = state();
    const [a, b] = s.applications;
    expect(refusal({ ...s, applications: [a!] })[0]).toContain('exactly two');
    expect(refusal({ ...s, applications: [a!, b!, a!] })[0]).toContain('exactly two');
  });

  it('refuses two applications collapsed into one client shape', () => {
    const s = state();
    const [a] = s.applications;
    const problems = refusal({ ...s, applications: [a!, { ...a! }] });
    expect(problems.join('\n')).toContain('different keys and names');
    expect(problems.join('\n')).toContain('different roles');
    expect(problems.join('\n')).toContain('share a redirect URI');
    expect(problems.join('\n')).toContain('share a hostname');
  });

  it('refuses distinct applications that share only a hostname', () => {
    const s = state();
    const [a, b] = s.applications;
    const sibling = { ...b!, redirectUris: [`https://${HOSTNAMES.console}/other`] };
    expect(refusal({ ...s, applications: [a!, sibling] }).join('\n')).toContain('share a hostname');
  });

  it('refuses an application requiring a role that is not defined', () => {
    const s = state();
    expect(refusal({ ...s, roles: [s.roles[0]!] }).join('\n')).toContain(
      'undefined role tenant-admin'
    );
  });

  it('refuses a tenant granted the owner role, none, or an unknown organisation', () => {
    const s = state();
    const [g] = s.grants;
    expect(
      refusal({
        ...s,
        grants: [{ ...g!, roleKeys: [ROLE_OWNER, ROLE_TENANT_ADMIN] }, s.grants[1]!],
      }).join('\n')
    ).toContain('granted the owner role');
    expect(refusal({ ...s, grants: [{ ...g!, roleKeys: [] }, s.grants[1]!] }).join('\n')).toContain(
      'granted no role'
    );
    expect(
      refusal({
        ...s,
        grants: [...s.grants, { slug: 'x', orgName: 'stranger', roleKeys: ['tenant-admin'] }],
      }).join('\n')
    ).toContain('not a tenant');
  });

  it('refuses a tenant organisation with no grant, and one that is the owner organisation', () => {
    const s = state();
    expect(refusal({ ...s, grants: [s.grants[0]!] }).join('\n')).toContain('has no grant');
    const clash = { slug: 'x', name: OWNER_ORG_NAME };
    expect(
      refusal({
        ...s,
        tenantOrgs: [clash],
        grants: [{ slug: 'x', orgName: OWNER_ORG_NAME, roleKeys: ['tenant-admin'] }],
      }).join('\n')
    ).toContain('is the owner organisation');
  });
});
