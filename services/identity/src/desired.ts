import type { IdentityConfig } from './config.js';
import { ConfigError } from './errors.js';

/** The owner's own organisation: home of the project and of the console's
 * users. Never granted to a tenant. */
export const OWNER_ORG_NAME = 'branchleft-owner';
export const TENANT_ORG_PREFIX = 'tenant-';
export const PROJECT_NAME = 'portal';

/** The two roles. A tenant organisation is granted the second one only, which
 * is what makes the first unobtainable for a tenant's user rather than merely
 * unchecked. The tenant role is one for the whole organisation: a second
 * tenant role (editors, say) is a new entry here and a new grant row, with no
 * change to how organisations, applications or token checks are shaped. */
export const ROLE_OWNER = 'owner';
export const ROLE_TENANT_ADMIN = 'tenant-admin';

export type ApplicationKey = 'console' | 'portal';

export interface DesiredApplication {
  readonly key: ApplicationKey;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
  /** The role this application's verifier requires; also what tells the two
   * applications apart in a token check. */
  readonly requiredRole: string;
}

export interface DesiredRole {
  readonly key: string;
  readonly displayName: string;
}

export interface DesiredTenantOrg {
  readonly slug: string;
  readonly name: string;
}

export interface DesiredGrant {
  readonly slug: string;
  readonly orgName: string;
  readonly roleKeys: readonly string[];
}

export interface DesiredState {
  readonly ownerOrgName: string;
  readonly tenantOrgs: readonly DesiredTenantOrg[];
  readonly projectName: string;
  readonly roles: readonly DesiredRole[];
  readonly applications: readonly DesiredApplication[];
  readonly grants: readonly DesiredGrant[];
}

export const CALLBACK_PATH = '/auth/callback';

export function tenantOrgName(slug: string): string {
  return `${TENANT_ORG_PREFIX}${slug}`;
}

/** The structural claims the design stands on, checked on the value rather
 * than trusted from the code that built it. The reconciler calls this again
 * before it writes anything, so a state built any other way is held to the
 * same rules. */
export function assertInvariants(state: DesiredState): void {
  const problems: string[] = [];
  const [first, second, ...rest] = state.applications;
  if (!first || !second || rest.length > 0) {
    problems.push('exactly two applications are required: the console and the portal');
  } else {
    if (first.key === second.key || first.name === second.name) {
      problems.push('the two applications must have different keys and names');
    }
    if (first.requiredRole === second.requiredRole) {
      problems.push('the two applications must require different roles');
    }
    const overlap = first.redirectUris.filter((uri) => second.redirectUris.includes(uri));
    if (overlap.length > 0) {
      problems.push(`the two applications share a redirect URI: ${overlap.join(', ')}`);
    }
    const origins = (app: DesiredApplication) => app.redirectUris.map((uri) => new URL(uri).host);
    const sharedHost = origins(first).filter((host) => origins(second).includes(host));
    if (sharedHost.length > 0) {
      problems.push(`the two applications share a hostname: ${sharedHost.join(', ')}`);
    }
  }
  const knownRoles = new Set(state.roles.map((role) => role.key));
  for (const application of state.applications) {
    if (!knownRoles.has(application.requiredRole)) {
      problems.push(
        `application ${application.key} requires undefined role ${application.requiredRole}`
      );
    }
  }
  const tenantNames = new Set(state.tenantOrgs.map((org) => org.name));
  for (const grant of state.grants) {
    if (!tenantNames.has(grant.orgName)) {
      problems.push(`grant names organisation ${grant.orgName}, which is not a tenant`);
    }
    if (grant.roleKeys.includes(ROLE_OWNER)) {
      problems.push(`tenant organisation ${grant.orgName} is granted the owner role`);
    }
    if (grant.roleKeys.length === 0) {
      problems.push(`tenant organisation ${grant.orgName} is granted no role`);
    }
  }
  for (const org of state.tenantOrgs) {
    if (!state.grants.some((grant) => grant.orgName === org.name)) {
      problems.push(`tenant organisation ${org.name} has no grant`);
    }
    if (org.name === state.ownerOrgName) {
      problems.push(`tenant organisation ${org.name} is the owner organisation`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

/** Everything Zitadel should hold for a validated tenant list. */
export function desiredState(config: IdentityConfig): DesiredState {
  const { hostnames } = config;
  const state: DesiredState = {
    ownerOrgName: OWNER_ORG_NAME,
    tenantOrgs: config.tenants.map((tenant) => ({
      slug: tenant.slug,
      name: tenantOrgName(tenant.slug),
    })),
    projectName: PROJECT_NAME,
    roles: [
      { key: ROLE_OWNER, displayName: 'OWNER' },
      { key: ROLE_TENANT_ADMIN, displayName: 'TENANT ADMINISTRATOR' },
    ],
    applications: [
      {
        key: 'console',
        name: 'owner-console',
        redirectUris: [`https://${hostnames.console}${CALLBACK_PATH}`],
        postLogoutRedirectUris: [`https://${hostnames.console}/`],
        requiredRole: ROLE_OWNER,
      },
      {
        key: 'portal',
        name: 'tenant-portal',
        redirectUris: [`https://${hostnames.portal}${CALLBACK_PATH}`],
        postLogoutRedirectUris: [`https://${hostnames.portal}/`],
        requiredRole: ROLE_TENANT_ADMIN,
      },
    ],
    grants: config.tenants.map((tenant) => ({
      slug: tenant.slug,
      orgName: tenantOrgName(tenant.slug),
      roleKeys: [ROLE_TENANT_ADMIN],
    })),
  };
  assertInvariants(state);
  return state;
}
