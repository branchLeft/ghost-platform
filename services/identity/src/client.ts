import type { SmtpConfig } from './config.js';
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

/** A mail provider Zitadel holds. The password is never returned by Zitadel,
 * so it is not here. */
export interface ExistingSmtp {
  readonly id: string;
  readonly host: string;
  readonly senderAddress: string;
  readonly senderName: string;
  readonly user: string;
  readonly tls: boolean;
  readonly description: string;
  readonly active: boolean;
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
  listSmtp(): Promise<readonly ExistingSmtp[]>;
  /** Creates an inactive provider. `host` is `name:port`; the account name is
   * the sender address. */
  createSmtp(smtp: SmtpConfig, password: string, description: string): Promise<{ id: string }>;
  activateSmtp(id: string): Promise<void>;
  /** Only ever called on a provider this reconciler created and has replaced. */
  deleteSmtp(id: string): Promise<void>;
}
