import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import {
  desiredState,
  OWNER_ORG_NAME,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
  tenantOrgName,
} from '../src/desired.js';
import { managementClient } from '../src/management.js';
import { reconcile } from '../src/reconcile.js';
import type { Outputs } from '../src/reconcile.js';
import { CLAIM_RESOURCE_OWNER } from '../src/tokens.js';
import { createTokenVerifier } from '../src/verifier.js';
import { createUser, instanceUrl, projectGrantId, signIn } from './signin.js';
import type { TestUser } from './signin.js';

const tokenFile = process.env['ZITADEL_TOKEN_FILE'] ?? '';
const config = validateConfig({
  hostnames: {
    console: 'console.proof.test',
    portal: 'portal.proof.test',
    identity: 'id.proof.test',
  },
  tenants: [
    { slug: 'alpha', displayName: 'ALPHA' },
    { slug: 'beta', displayName: 'BETA' },
  ],
});

let outputs: Outputs;
let alpha: TestUser;
let beta: TestUser;
let owner: TestUser;
let ownerWithTenantRole: TestUser;

const consoleRedirect = 'https://console.proof.test/auth/callback';
const portalRedirect = 'https://portal.proof.test/auth/callback';

/** Verifiers as an application builds them: the real key set, the pinned
 * algorithm, and an explicit list of the organisations each admits. */
function portalVerifier() {
  return createTokenVerifier({
    issuer: instanceUrl,
    clientId: outputs.clientIds.portal,
    requiredRole: ROLE_TENANT_ADMIN,
    allowedOrgIds: new Set(Object.values(outputs.tenantOrgIds)),
    leewaySeconds: 30,
  });
}

function consoleVerifier() {
  return createTokenVerifier({
    issuer: instanceUrl,
    clientId: outputs.clientIds.console,
    requiredRole: ROLE_OWNER,
    allowedOrgIds: new Set([outputs.ownerOrgId]),
    leewaySeconds: 30,
  });
}

const client = managementClient({
  baseUrl: instanceUrl,
  token: () => readFileSync(tokenFile, 'utf8').trim(),
  fetch: (target, init) => fetch(target, init),
});

const setup = async (): Promise<void> => {
  outputs = (await reconcile(client, desiredState(config))).outputs;
  const tenant = async (slug: string): Promise<TestUser> => {
    const orgId = outputs.tenantOrgIds[slug]!;
    return createUser({
      orgId,
      projectId: outputs.projectId,
      roleKey: ROLE_TENANT_ADMIN,
      projectGrantId: await projectGrantId(outputs.ownerOrgId, outputs.projectId, orgId),
    });
  };
  alpha = await tenant('alpha');
  beta = await tenant('beta');
  ownerWithTenantRole = await createUser({
    orgId: outputs.ownerOrgId,
    projectId: outputs.projectId,
    roleKey: ROLE_TENANT_ADMIN,
  });
  owner = await createUser({
    orgId: outputs.ownerOrgId,
    projectId: outputs.projectId,
    roleKey: ROLE_OWNER,
  });
};

describe('reconciling a real Zitadel', () => {
  it('creates two tenant organisations, and a second run changes nothing', async () => {
    const first = await reconcile(client, desiredState(config));
    expect(first.drift).toBe(false);
    expect(
      first.actions.filter((a) => a.kind === 'organisation' && a.status === 'created')
    ).toHaveLength(2 + 1);

    const second = await reconcile(client, desiredState(config));
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
    expect(second.outputs).toEqual(first.outputs);
  });

  it('holds two distinct clients and gives each tenant the tenant role only', async () => {
    const { outputs } = await reconcile(client, desiredState(config));
    expect(outputs.clientIds.console).not.toBe(outputs.clientIds.portal);
    expect(outputs.tenantOrgIds['alpha']).not.toBe(outputs.tenantOrgIds['beta']);
    expect((await client.findOrg(OWNER_ORG_NAME))?.id).toBe(outputs.ownerOrgId);
    expect((await client.findOrg(tenantOrgName('alpha')))?.id).toBe(outputs.tenantOrgIds['alpha']);
    for (const org of Object.values(outputs.tenantOrgIds)) {
      const grant = await client.findGrant(outputs.ownerOrgId, outputs.projectId, org);
      expect(grant?.roleKeys).toEqual([ROLE_TENANT_ADMIN]);
      expect(grant?.roleKeys).not.toContain(ROLE_OWNER);
    }
    const consoleApp = await client.findApplication(
      outputs.ownerOrgId,
      outputs.projectId,
      'owner-console'
    );
    const portalApp = await client.findApplication(
      outputs.ownerOrgId,
      outputs.projectId,
      'tenant-portal'
    );
    expect(consoleApp?.redirectUris).toEqual(['https://console.proof.test/auth/callback']);
    expect(portalApp?.redirectUris).toEqual(['https://portal.proof.test/auth/callback']);
  });
});

describe('with tokens Zitadel really signed', () => {
  beforeAll(setup, 120000);

  it('signs each tenant administrator in to the portal, bound to their own organisation', async () => {
    for (const [slug, user] of [
      ['alpha', alpha],
      ['beta', beta],
    ] as const) {
      const out = await signIn({
        clientId: outputs.clientIds.portal,
        redirectUri: portalRedirect,
        projectId: outputs.projectId,
        user,
      });
      expect(out.refusal).toBeUndefined();
      const verdict = await portalVerifier().verify(out.token!);
      expect(verdict).toMatchObject({ ok: true, orgId: outputs.tenantOrgIds[slug] });
    }
  });

  it('cannot give organisation A a token carrying organisation B', async () => {
    const betaOrg = outputs.tenantOrgIds['beta']!;
    const out = await signIn({
      clientId: outputs.clientIds.portal,
      redirectUri: portalRedirect,
      projectId: outputs.projectId,
      user: alpha,
      extraScopes: [`urn:zitadel:iam:org:id:${betaOrg}`],
    });
    if (out.claims) {
      expect(out.claims[CLAIM_RESOURCE_OWNER]).toBe(outputs.tenantOrgIds['alpha']);
      expect(JSON.stringify(out.claims)).not.toContain(betaOrg);
      expect(await portalVerifier().verify(out.token!)).toMatchObject({
        ok: true,
        orgId: outputs.tenantOrgIds['alpha'],
      });
    } else {
      expect(out.refusal).toContain('no member of the required organization');
    }
  });

  it('refuses a real console token at the portal check, and a real portal token at the console check', async () => {
    const consoleToken = await signIn({
      clientId: outputs.clientIds.console,
      redirectUri: consoleRedirect,
      projectId: outputs.projectId,
      user: owner,
    });
    expect(consoleToken.refusal).toBeUndefined();
    expect((await consoleVerifier().verify(consoleToken.token!)).ok).toBe(true);
    expect(await portalVerifier().verify(consoleToken.token!)).toEqual({
      ok: false,
      reason: 'token was issued to a different application',
    });

    const portalToken = await signIn({
      clientId: outputs.clientIds.portal,
      redirectUri: portalRedirect,
      projectId: outputs.projectId,
      user: alpha,
    });
    expect((await consoleVerifier().verify(portalToken.token!)).ok).toBe(false);
  });

  it('refuses a tenant administrator at the console even when Zitadel signs them in to it', async () => {
    const out = await signIn({
      clientId: outputs.clientIds.console,
      redirectUri: consoleRedirect,
      projectId: outputs.projectId,
      user: alpha,
    });
    if (out.claims) {
      expect((await consoleVerifier().verify(out.token!)).ok).toBe(false);
    } else {
      expect(out.refusal).toBeDefined();
    }
  });

  it('refuses, at the portal, an owner-organisation user who holds the tenant role', async () => {
    const out = await signIn({
      clientId: outputs.clientIds.portal,
      redirectUri: portalRedirect,
      projectId: outputs.projectId,
      user: ownerWithTenantRole,
    });
    expect(out.refusal).toBeUndefined();
    expect(out.claims?.[CLAIM_RESOURCE_OWNER]).toBe(outputs.ownerOrgId);
    expect(await portalVerifier().verify(out.token!)).toEqual({
      ok: false,
      reason: 'organisation is not permitted here',
    });
  });

  it('refuses a real token whose payload was altered, and one with the signature removed', async () => {
    const out = await signIn({
      clientId: outputs.clientIds.portal,
      redirectUri: portalRedirect,
      projectId: outputs.projectId,
      user: alpha,
    });
    const [header, payload, signature] = out.token!.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(
      JSON.stringify({ ...claims, [CLAIM_RESOURCE_OWNER]: outputs.tenantOrgIds['beta'] })
    ).toString('base64url');
    expect(await portalVerifier().verify(`${header}.${forged}.${signature}`)).toEqual({
      ok: false,
      reason: 'token signature is invalid',
    });
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'x' })).toString('base64url');
    expect((await portalVerifier().verify(`${none}.${payload}.`)).ok).toBe(false);
  });
});
