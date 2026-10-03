import type { ExistingApplication, ExistingGrant, ZitadelClient } from '../src/client.js';
import type { DesiredApplication } from '../src/desired.js';

/** An in-memory stand-in with the one behaviour the reconciler depends on:
 * the same name resolves to the same record, and a write is counted. */
export class FakeZitadel implements ZitadelClient {
  orgs = new Map<string, string>();
  projects = new Map<string, string>();
  roles = new Set<string>();
  apps = new Map<string, ExistingApplication>();
  grants = new Map<string, ExistingGrant>();
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
