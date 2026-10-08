import type { ExistingApplication, ExistingGrant, ZitadelClient } from './client.js';
import type { DesiredApplication } from './desired.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ManagementOptions {
  /** The instance's own origin, e.g. `http://localhost:8080` for a local
   * container or the sign-in service's `https://` name. */
  readonly baseUrl: string;
  /** Read per request so a rotated credential is picked up without a restart.
   * Never logged and never echoed into an error. */
  readonly token: () => string;
  readonly fetch: FetchLike;
}

/** Carries the status and the path only. A response body can echo request
 * fields, and a request can carry a credential-derived header. */
export class ZitadelApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Zitadel answered ${status} for ${path}`);
    this.name = 'ZitadelApiError';
    this.status = status;
    this.path = path;
  }
}

export class ZitadelShapeError extends Error {
  constructor(path: string, expected: string) {
    super(`Zitadel's answer for ${path} did not contain ${expected}`);
    this.name = 'ZitadelShapeError';
  }
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function results(body: Json, path: string): Json[] {
  const list = body['result'];
  // An empty search may omit the key entirely; anything else must be a list.
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ZitadelShapeError(path, 'a result list');
  return list.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new ZitadelShapeError(path, 'object results');
    return record;
  });
}

function requireString(body: Json, key: string, path: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new ZitadelShapeError(path, key);
  return value;
}

const NAME_EQUALS = (name: string) => ({
  queries: [{ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
});

export function managementClient(options: ManagementOptions): ZitadelClient {
  const base = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;

  async function call(path: string, body: unknown, orgId?: string): Promise<Json> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${options.token()}`,
    };
    if (orgId !== undefined) headers['x-zitadel-orgid'] = orgId;
    const response = await options.fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ZitadelApiError(response.status, path);
    const parsed = asRecord(await response.json());
    if (!parsed) throw new ZitadelShapeError(path, 'a JSON object');
    return parsed;
  }

  // The server's name filter is a request, not a guarantee: the match is
  // re-checked here so a filter that is ignored cannot return another
  // organisation's resource.
  async function findByName(path: string, name: string, orgId?: string): Promise<Json | null> {
    const found = results(await call(path, NAME_EQUALS(name), orgId), path).filter(
      (entry) => entry['name'] === name
    );
    if (found.length > 1) throw new ZitadelShapeError(path, `one match for ${name}`);
    return found[0] ?? null;
  }

  return {
    async findOrg(name) {
      const path = '/admin/v1/orgs/_search';
      const entry = await findByName(path, name);
      return entry ? { id: requireString(entry, 'id', path) } : null;
    },
    async createOrg(name) {
      const path = '/management/v1/orgs';
      return { id: requireString(await call(path, { name }), 'id', path) };
    },
    async findProject(ownerOrgId, name) {
      const path = '/management/v1/projects/_search';
      const entry = await findByName(path, name, ownerOrgId);
      return entry ? { id: requireString(entry, 'id', path) } : null;
    },
    async createProject(ownerOrgId, name) {
      const path = '/management/v1/projects';
      const body = await call(
        path,
        {
          name,
          // Roles travel in the token, a user needs a role to sign in at all,
          // and an organisation needs a grant to use the project.
          projectRoleAssertion: true,
          projectRoleCheck: true,
          hasProjectCheck: true,
        },
        ownerOrgId
      );
      return { id: requireString(body, 'id', path) };
    },
    async listRoleKeys(ownerOrgId, projectId) {
      const path = `/management/v1/projects/${encodeURIComponent(projectId)}/roles/_search`;
      return results(await call(path, {}, ownerOrgId), path).map((entry) =>
        requireString(entry, 'key', path)
      );
    },
    async createRole(ownerOrgId, projectId, key, displayName) {
      await call(
        `/management/v1/projects/${encodeURIComponent(projectId)}/roles`,
        { roleKey: key, displayName },
        ownerOrgId
      );
    },
    async findApplication(ownerOrgId, projectId, name): Promise<ExistingApplication | null> {
      const path = `/management/v1/projects/${encodeURIComponent(projectId)}/apps/_search`;
      const entry = await findByName(path, name, ownerOrgId);
      if (!entry) return null;
      const oidc = asRecord(entry['oidcConfig']);
      if (!oidc) throw new ZitadelShapeError(path, 'an OIDC configuration');
      return {
        id: requireString(entry, 'id', path),
        clientId: requireString(oidc, 'clientId', path),
        redirectUris: asStringArray(oidc['redirectUris']),
        postLogoutRedirectUris: asStringArray(oidc['postLogoutRedirectUris']),
      };
    },
    async createApplication(ownerOrgId, projectId, application: DesiredApplication) {
      const path = `/management/v1/projects/${encodeURIComponent(projectId)}/apps/oidc`;
      const body = await call(
        path,
        {
          name: application.name,
          redirectUris: application.redirectUris,
          postLogoutRedirectUris: application.postLogoutRedirectUris,
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
          appType: 'OIDC_APP_TYPE_WEB',
          // A public client with PKCE: no client secret exists to custody.
          authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
          version: 'OIDC_VERSION_1_0',
          devMode: application.devMode,
          accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: true,
        },
        ownerOrgId
      );
      return {
        id: requireString(body, 'appId', path),
        clientId: requireString(body, 'clientId', path),
      };
    },
    async findGrant(ownerOrgId, projectId, grantedOrgId): Promise<ExistingGrant | null> {
      const path = `/management/v1/projects/${encodeURIComponent(projectId)}/grants/_search`;
      const matches = results(await call(path, {}, ownerOrgId), path).filter(
        (entry) => entry['grantedOrgId'] === grantedOrgId
      );
      if (matches.length > 1) throw new ZitadelShapeError(path, `one grant for ${grantedOrgId}`);
      const entry = matches[0];
      if (!entry) return null;
      return {
        id: requireString(entry, 'grantId', path),
        roleKeys: asStringArray(entry['grantedRoleKeys']),
      };
    },
    async createGrant(ownerOrgId, projectId, grantedOrgId, roleKeys) {
      await call(
        `/management/v1/projects/${encodeURIComponent(projectId)}/grants`,
        { grantedOrgId, roleKeys },
        ownerOrgId
      );
    },
  };
}
