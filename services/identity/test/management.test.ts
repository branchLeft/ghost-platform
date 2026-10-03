import { describe, expect, it } from 'vitest';
import { desiredState } from '../src/desired.js';
import { validateConfig } from '../src/config.js';
import { managementClient, ZitadelApiError, ZitadelShapeError } from '../src/management.js';
import type { FetchLike } from '../src/management.js';
import { HOSTNAMES } from './fakes.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const client = managementClient({ baseUrl: 'http://zitadel.test/', token: () => 'T0KEN', fetch });
  return { client, calls };
}

const app = desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: [] })).applications[1]!;

describe('managementClient', () => {
  it('sends the bearer token, the org header and a JSON body, and finds an org by exact name', async () => {
    const { client, calls } = harness(() => ({
      body: { result: [{ id: 'o1', name: 'tenant-a' }] },
    }));
    expect(await client.findOrg('tenant-a')).toEqual({ id: 'o1' });
    expect(calls[0]?.url).toBe('http://zitadel.test/admin/v1/orgs/_search');
    expect(calls[0]?.headers['authorization']).toBe('Bearer T0KEN');
    expect(calls[0]?.headers['x-zitadel-orgid']).toBeUndefined();
  });

  it('does not trust the server-side filter: another org’s record is not a match', async () => {
    const { client } = harness(() => ({ body: { result: [{ id: 'o9', name: 'tenant-b' }] } }));
    expect(await client.findOrg('tenant-a')).toBeNull();
  });

  it('treats an absent result list as no match, and refuses two matches', async () => {
    expect(await harness(() => ({ body: {} })).client.findOrg('x')).toBeNull();
    const dup = harness(() => ({
      body: {
        result: [
          { id: '1', name: 'x' },
          { id: '2', name: 'x' },
        ],
      },
    }));
    await expect(dup.client.findOrg('x')).rejects.toBeInstanceOf(ZitadelShapeError);
  });

  it('creates an organisation and returns its id', async () => {
    const { client, calls } = harness(() => ({ body: { id: 'new' } }));
    expect(await client.createOrg('tenant-a')).toEqual({ id: 'new' });
    expect(calls[0]?.body).toEqual({ name: 'tenant-a' });
  });

  it('scopes project calls to the owner organisation and sets the role and grant checks', async () => {
    const { client, calls } = harness((call) =>
      call.url.endsWith('_search') ? { body: { result: [] } } : { body: { id: 'p1' } }
    );
    expect(await client.findProject('owner-1', 'portal')).toBeNull();
    expect(await client.createProject('owner-1', 'portal')).toEqual({ id: 'p1' });
    expect(calls.every((c) => c.headers['x-zitadel-orgid'] === 'owner-1')).toBe(true);
    expect(calls[1]?.body).toMatchObject({
      projectRoleAssertion: true,
      projectRoleCheck: true,
      hasProjectCheck: true,
    });
  });

  it('lists and creates roles', async () => {
    const { client, calls } = harness((call) =>
      call.url.endsWith('_search') ? { body: { result: [{ key: 'owner' }] } } : { body: {} }
    );
    expect(await client.listRoleKeys('o', 'p')).toEqual(['owner']);
    await client.createRole('o', 'p', 'tenant-admin', 'TENANT ADMINISTRATOR');
    expect(calls[1]?.body).toEqual({
      roleKey: 'tenant-admin',
      displayName: 'TENANT ADMINISTRATOR',
    });
  });

  it('refuses a role without a key', async () => {
    const { client } = harness(() => ({ body: { result: [{}] } }));
    await expect(client.listRoleKeys('o', 'p')).rejects.toBeInstanceOf(ZitadelShapeError);
  });

  it('reads an application’s client id and redirect URIs', async () => {
    const { client } = harness(() => ({
      body: {
        result: [
          {
            id: 'a1',
            name: app.name,
            oidcConfig: { clientId: 'c1', redirectUris: ['u'], postLogoutRedirectUris: ['v', 3] },
          },
        ],
      },
    }));
    expect(await client.findApplication('o', 'p', app.name)).toEqual({
      id: 'a1',
      clientId: 'c1',
      redirectUris: ['u'],
      postLogoutRedirectUris: ['v'],
    });
  });

  it('tolerates missing URI lists and refuses an application with no OIDC configuration', async () => {
    const lax = harness(() => ({
      body: { result: [{ id: 'a', name: 'n', oidcConfig: { clientId: 'c' } }] },
    }));
    expect((await lax.client.findApplication('o', 'p', 'n'))?.redirectUris).toEqual([]);
    const none = harness(() => ({ body: { result: [{ id: 'a', name: 'n' }] } }));
    await expect(none.client.findApplication('o', 'p', 'n')).rejects.toBeInstanceOf(
      ZitadelShapeError
    );
    expect(
      await harness(() => ({ body: { result: [] } })).client.findApplication('o', 'p', 'n')
    ).toBeNull();
  });

  it('creates a public PKCE client with code flow only and no implicit grant', async () => {
    const { client, calls } = harness(() => ({ body: { appId: 'a1', clientId: 'c1' } }));
    expect(await client.createApplication('o', 'p', app)).toEqual({ id: 'a1', clientId: 'c1' });
    expect(calls[0]?.body).toMatchObject({
      redirectUris: app.redirectUris,
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
      grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      devMode: false,
    });
  });

  it('finds a grant by the organisation it was granted to, and creates one', async () => {
    const body = {
      result: [{ grantId: 'g1', grantedOrgId: 'o2', grantedRoleKeys: ['tenant-admin'] }],
    };
    const { client, calls } = harness((call) =>
      call.url.endsWith('_search') ? { body } : { body: {} }
    );
    expect(await client.findGrant('o', 'p', 'o2')).toEqual({
      id: 'g1',
      roleKeys: ['tenant-admin'],
    });
    expect(await client.findGrant('o', 'p', 'o3')).toBeNull();
    await client.createGrant('o', 'p', 'o3', ['tenant-admin']);
    expect(calls[2]?.body).toEqual({ grantedOrgId: 'o3', roleKeys: ['tenant-admin'] });
  });

  it('refuses two grants for one organisation', async () => {
    const entry = { grantId: 'g', grantedOrgId: 'o2', grantedRoleKeys: [] };
    const { client } = harness(() => ({ body: { result: [entry, entry] } }));
    await expect(client.findGrant('o', 'p', 'o2')).rejects.toBeInstanceOf(ZitadelShapeError);
  });

  it('raises the status and path, and never the token or the response body', async () => {
    const { client } = harness(() => ({ status: 403, body: { message: 'Bearer T0KEN leaked' } }));
    const error = await client.createOrg('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZitadelApiError);
    expect((error as ZitadelApiError).status).toBe(403);
    expect((error as Error).message).toBe('Zitadel answered 403 for /management/v1/orgs');
    expect((error as Error).message).not.toContain('T0KEN');
  });

  it('refuses a body that is not an object, or a result that is not a list of objects', async () => {
    await expect(harness(() => ({ body: [] })).client.createOrg('x')).rejects.toBeInstanceOf(
      ZitadelShapeError
    );
    await expect(
      harness(() => ({ body: { result: 'no' } })).client.findOrg('x')
    ).rejects.toBeInstanceOf(ZitadelShapeError);
    await expect(
      harness(() => ({ body: { result: [1] } })).client.findOrg('x')
    ).rejects.toBeInstanceOf(ZitadelShapeError);
    await expect(harness(() => ({ body: {} })).client.createOrg('x')).rejects.toBeInstanceOf(
      ZitadelShapeError
    );
  });

  it('re-reads the token on every request', async () => {
    let n = 0;
    const seen: string[] = [];
    const client = managementClient({
      baseUrl: 'http://z',
      token: () => `t${(n += 1)}`,
      fetch: async (_u, init) => {
        seen.push(init.headers['authorization'] ?? '');
        return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
      },
    });
    await client.createOrg('a');
    await client.createOrg('b');
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });
});
