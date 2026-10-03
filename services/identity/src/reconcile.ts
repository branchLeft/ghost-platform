import type { ZitadelClient } from './client.js';
import { assertInvariants } from './desired.js';
import type { ApplicationKey, DesiredState } from './desired.js';

export type ActionStatus = 'created' | 'unchanged' | 'drift';

export interface Action {
  readonly kind: 'organisation' | 'project' | 'role' | 'application' | 'grant';
  readonly name: string;
  readonly status: ActionStatus;
  readonly detail?: string;
}

/** The identifiers a consumer needs. None is a secret: the applications are
 * public PKCE clients, so there is no client secret to return or to lose. */
export interface Outputs {
  readonly ownerOrgId: string;
  readonly projectId: string;
  readonly tenantOrgIds: Readonly<Record<string, string>>;
  readonly clientIds: Readonly<Record<ApplicationKey, string>>;
}

export interface ReconcileResult {
  readonly actions: readonly Action[];
  readonly outputs: Outputs;
  /** True when anything that exists disagrees with the desired state. Drift
   * is reported and never overwritten: a redirect URI or a grant that differs
   * from the list was changed by someone, and which side is right is theirs
   * to say. */
  readonly drift: boolean;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** Creates what is missing and leaves what exists alone. A second run against
 * an unchanged list performs no write. */
export async function reconcile(
  client: ZitadelClient,
  desired: DesiredState
): Promise<ReconcileResult> {
  assertInvariants(desired);
  const actions: Action[] = [];
  const record = (action: Action): void => {
    actions.push(action);
  };

  const ownerOrg = await ensureOrg(client, desired.ownerOrgName, record);
  const ownerOrgId = ownerOrg.id;

  let project = await client.findProject(ownerOrgId, desired.projectName);
  if (project) {
    record({ kind: 'project', name: desired.projectName, status: 'unchanged' });
  } else {
    project = await client.createProject(ownerOrgId, desired.projectName);
    record({ kind: 'project', name: desired.projectName, status: 'created' });
  }
  const projectId = project.id;

  const existingRoles = await client.listRoleKeys(ownerOrgId, projectId);
  for (const role of desired.roles) {
    if (existingRoles.includes(role.key)) {
      record({ kind: 'role', name: role.key, status: 'unchanged' });
    } else {
      await client.createRole(ownerOrgId, projectId, role.key, role.displayName);
      record({ kind: 'role', name: role.key, status: 'created' });
    }
  }

  const clientIds: Partial<Record<ApplicationKey, string>> = {};
  for (const application of desired.applications) {
    const existing = await client.findApplication(ownerOrgId, projectId, application.name);
    if (existing) {
      clientIds[application.key] = existing.clientId;
      const matches =
        sameSet(existing.redirectUris, application.redirectUris) &&
        sameSet(existing.postLogoutRedirectUris, application.postLogoutRedirectUris);
      record(
        matches
          ? { kind: 'application', name: application.name, status: 'unchanged' }
          : {
              kind: 'application',
              name: application.name,
              status: 'drift',
              detail: 'redirect URIs differ from the configured hostnames',
            }
      );
    } else {
      const created = await client.createApplication(ownerOrgId, projectId, application);
      clientIds[application.key] = created.clientId;
      record({ kind: 'application', name: application.name, status: 'created' });
    }
  }

  const tenantOrgIds: Record<string, string> = {};
  for (const tenant of desired.tenantOrgs) {
    const org = await ensureOrg(client, tenant.name, record);
    tenantOrgIds[tenant.slug] = org.id;
  }

  for (const grant of desired.grants) {
    const grantedOrgId = tenantOrgIds[grant.slug];
    if (grantedOrgId === undefined) {
      throw new Error(`no organisation id for ${grant.orgName}`);
    }
    const existing = await client.findGrant(ownerOrgId, projectId, grantedOrgId);
    if (!existing) {
      await client.createGrant(ownerOrgId, projectId, grantedOrgId, grant.roleKeys);
      record({ kind: 'grant', name: grant.orgName, status: 'created' });
    } else if (sameSet(existing.roleKeys, grant.roleKeys)) {
      record({ kind: 'grant', name: grant.orgName, status: 'unchanged' });
    } else {
      record({
        kind: 'grant',
        name: grant.orgName,
        status: 'drift',
        detail: `grant holds [${existing.roleKeys.join(', ')}], expected [${grant.roleKeys.join(', ')}]`,
      });
    }
  }

  const console_ = clientIds.console;
  const portal = clientIds.portal;
  if (console_ === undefined || portal === undefined) {
    throw new Error('an application was neither found nor created');
  }
  return {
    actions,
    outputs: { ownerOrgId, projectId, tenantOrgIds, clientIds: { console: console_, portal } },
    drift: actions.some((action) => action.status === 'drift'),
  };
}

async function ensureOrg(
  client: ZitadelClient,
  name: string,
  record: (action: Action) => void
): Promise<{ id: string }> {
  const existing = await client.findOrg(name);
  if (existing) {
    record({ kind: 'organisation', name, status: 'unchanged' });
    return existing;
  }
  const created = await client.createOrg(name);
  record({ kind: 'organisation', name, status: 'created' });
  return created;
}
