import type { DesiredApplication } from './desired.js';

export interface ExistingApplication {
  readonly id: string;
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
}

export interface ExistingGrant {
  readonly id: string;
  readonly roleKeys: readonly string[];
}

/** What the reconciler needs from Zitadel, and no more. Every read is by
 * name or by owning organisation, never by a position in a list, and nothing
 * here deletes: removing a tenant's organisation is a decision for a person. */
export interface ZitadelClient {
  findOrg(name: string): Promise<{ id: string } | null>;
  createOrg(name: string): Promise<{ id: string }>;
  findProject(ownerOrgId: string, name: string): Promise<{ id: string } | null>;
  createProject(ownerOrgId: string, name: string): Promise<{ id: string }>;
  listRoleKeys(ownerOrgId: string, projectId: string): Promise<readonly string[]>;
  createRole(
    ownerOrgId: string,
    projectId: string,
    key: string,
    displayName: string
  ): Promise<void>;
  findApplication(
    ownerOrgId: string,
    projectId: string,
    name: string
  ): Promise<ExistingApplication | null>;
  createApplication(
    ownerOrgId: string,
    projectId: string,
    application: DesiredApplication
  ): Promise<{ id: string; clientId: string }>;
  findGrant(
    ownerOrgId: string,
    projectId: string,
    grantedOrgId: string
  ): Promise<ExistingGrant | null>;
  createGrant(
    ownerOrgId: string,
    projectId: string,
    grantedOrgId: string,
    roleKeys: readonly string[]
  ): Promise<void>;
}
