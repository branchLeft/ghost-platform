import type {
  ExistingApplication,
  ExistingGrant,
  ExistingSmtp,
  ZitadelClient,
} from '../src/client.js';
import type { SmtpConfig } from '../src/config.js';
import type { DesiredApplication } from '../src/desired.js';

/** An in-memory stand-in with the one behaviour the reconciler depends on:
 * the same name resolves to the same record, and a write is counted. */
export class FakeZitadel implements ZitadelClient {
  orgs = new Map<string, string>();
  projects = new Map<string, string>();
  roles = new Set<string>();
  apps = new Map<string, ExistingApplication>();
  grants = new Map<string, ExistingGrant>();
  smtp = new Map<string, ExistingSmtp & { password: string }>();
  writes = 0;
  private counter = 0;

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  async findOrg(name: string) {
    const id = this.orgs.get(name);
    return id ? { id } : null;
  }
  async createOrg(name: string) {
    this.writes += 1;
    const id = this.next('org');
    this.orgs.set(name, id);
    return { id };
  }
  async findProject(_owner: string, name: string) {
    const id = this.projects.get(name);
    return id ? { id } : null;
  }
  async createProject(_owner: string, name: string) {
    this.writes += 1;
    const id = this.next('project');
    this.projects.set(name, id);
    return { id };
  }
  async listRoleKeys() {
    return [...this.roles];
  }
  async createRole(_owner: string, _project: string, key: string) {
    this.writes += 1;
    this.roles.add(key);
  }
  async findApplication(_owner: string, _project: string, name: string) {
    return this.apps.get(name) ?? null;
  }
  async createApplication(_owner: string, _project: string, application: DesiredApplication) {
    this.writes += 1;
    const id = this.next('app');
    const clientId = this.next('client');
    this.apps.set(application.name, {
      id,
      clientId,
      redirectUris: application.redirectUris,
      postLogoutRedirectUris: application.postLogoutRedirectUris,
    });
    return { id, clientId };
  }
  async findGrant(_owner: string, _project: string, grantedOrgId: string) {
    return this.grants.get(grantedOrgId) ?? null;
  }
  async createGrant(
    _owner: string,
    _project: string,
    grantedOrgId: string,
    roleKeys: readonly string[]
  ) {
    this.writes += 1;
    this.grants.set(grantedOrgId, { id: this.next('grant'), roleKeys });
  }

  /** Behaves as Zitadel v4.19.4 does: a provider's password is fixed when it is
   * created, one provider is active at a time, and the password is never read
   * back. */
  async listSmtp() {
    return [...this.smtp.values()].map(({ password: _password, ...rest }) => rest);
  }
  async createSmtp(smtp: SmtpConfig, password: string, description: string) {
    this.writes += 1;
    const id = this.next('smtp');
    this.smtp.set(id, {
      id,
      host: `${smtp.host}:${smtp.port}`,
      senderAddress: smtp.senderAddress,
      senderName: smtp.senderName,
      user: smtp.senderAddress,
      tls: smtp.tls,
      description,
      active: false,
      password,
    });
    return { id };
  }
  async activateSmtp(id: string) {
    this.writes += 1;
    for (const [key, entry] of this.smtp) this.smtp.set(key, { ...entry, active: key === id });
  }
  async deleteSmtp(id: string) {
    this.writes += 1;
    this.smtp.delete(id);
  }
}

export const HOSTNAMES = {
  console: 'console.example.test',
  portal: 'portal.example.test',
  identity: 'id.example.test',
};

export const TWO_TENANTS = [
  { slug: 'alpha', displayName: 'ALPHA' },
  { slug: 'beta-two', displayName: 'BETA' },
];
