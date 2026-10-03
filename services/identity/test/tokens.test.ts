import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import { desiredState, ROLE_OWNER, ROLE_TENANT_ADMIN } from '../src/desired.js';
import { reconcile } from '../src/reconcile.js';
import type { Outputs } from '../src/reconcile.js';
import { CLAIM_PROJECT_ROLES, CLAIM_RESOURCE_OWNER, verifyClaims } from '../src/tokens.js';
import type { Claims, VerifierOptions } from '../src/tokens.js';
import { FakeZitadel, HOSTNAMES, TWO_TENANTS } from './fakes.js';

const ISSUER = `https://${HOSTNAMES.identity}`;
const NOW = 1_800_000_000;
let projectClients: string[] = ['sibling-1'];

/** The shape Zitadel really issues, read from a live instance: `aud` lists
 * every application of the project plus the project id, `client_id` names the
 * application the token was issued to, and the role is keyed by the
 * organisation it was granted to. */
function mint(clientId: string, orgId: string, role: string, extra: Claims = {}): Claims {
  return {
    iss: ISSUER,
    aud: [...projectClients, 'project-1'],
    client_id: clientId,
    sub: 'user-1',
    exp: NOW + 600,
    [CLAIM_RESOURCE_OWNER]: orgId,
    [CLAIM_PROJECT_ROLES]: { [role]: { [orgId]: 'org.example.test' } },
    ...extra,
  };
}

async function setup(): Promise<{
  outputs: Outputs;
  consoleVerifier: VerifierOptions;
  portalVerifier: VerifierOptions;
}> {
  const { outputs } = await reconcile(
    new FakeZitadel(),
    desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: TWO_TENANTS }))
  );
  projectClients = [outputs.clientIds.console, outputs.clientIds.portal];
  return {
    outputs,
    consoleVerifier: {
      issuer: ISSUER,
      clientId: outputs.clientIds.console,
      requiredRole: ROLE_OWNER,
      allowedOrgIds: new Set([outputs.ownerOrgId]),
      now: NOW,
    },
    portalVerifier: {
      issuer: ISSUER,
      clientId: outputs.clientIds.portal,
      requiredRole: ROLE_TENANT_ADMIN,
      allowedOrgIds: new Set(Object.values(outputs.tenantOrgIds)),
      now: NOW,
    },
  };
}

describe('the two applications refuse each other’s tokens', () => {
  it('accepts each application’s own token', async () => {
    const { outputs, consoleVerifier, portalVerifier } = await setup();
    const alpha = outputs.tenantOrgIds['alpha']!;
    expect(
      verifyClaims(mint(outputs.clientIds.portal, alpha, ROLE_TENANT_ADMIN), portalVerifier)
    ).toEqual({
      ok: true,
      orgId: alpha,
      subject: 'user-1',
    });
    expect(
      verifyClaims(mint(outputs.clientIds.console, outputs.ownerOrgId, ROLE_OWNER), consoleVerifier)
        .ok
    ).toBe(true);
  });

  it('refuses a console token at the portal, and a portal token at the console', async () => {
    const { outputs, consoleVerifier, portalVerifier } = await setup();
    const alpha = outputs.tenantOrgIds['alpha']!;
    // Same user, same role, same organisation, and an audience that lists both
    // applications as Zitadel's does: only `client_id` differs.
    const forPortal = verifyClaims(
      mint(outputs.clientIds.console, alpha, ROLE_TENANT_ADMIN),
      portalVerifier
    );
    expect(forPortal).toEqual({ ok: false, reason: 'token was issued to a different application' });
    const forConsole = verifyClaims(
      mint(outputs.clientIds.portal, outputs.ownerOrgId, ROLE_OWNER),
      consoleVerifier
    );
    expect(forConsole).toEqual({
      ok: false,
      reason: 'token was issued to a different application',
    });
  });

  it('refuses a token whose audience omits the application, whatever its client_id says', async () => {
    const { outputs, portalVerifier } = await setup();
    const alpha = outputs.tenantOrgIds['alpha']!;
    const forged = mint(outputs.clientIds.portal, alpha, ROLE_TENANT_ADMIN, {
      aud: [outputs.clientIds.console],
    });
    expect(verifyClaims(forged, portalVerifier)).toEqual({
      ok: false,
      reason: 'token was not issued to this application',
    });
  });

  it('refuses a tenant administrator at the console even with the console’s audience', async () => {
    const { outputs, consoleVerifier } = await setup();
    const alpha = outputs.tenantOrgIds['alpha']!;
    expect(
      verifyClaims(mint(outputs.clientIds.console, alpha, ROLE_OWNER), consoleVerifier)
    ).toEqual({
      ok: false,
      reason: 'organisation is not permitted here',
    });
    expect(
      verifyClaims(mint(outputs.clientIds.console, alpha, ROLE_TENANT_ADMIN), consoleVerifier).ok
    ).toBe(false);
  });
});

describe('a tenant’s organisation is the only source of its tenant', () => {
  it('refuses an owner-organisation user who holds the tenant role at the portal', async () => {
    const { outputs, portalVerifier } = await setup();
    const claims = mint(outputs.clientIds.portal, outputs.ownerOrgId, ROLE_TENANT_ADMIN);
    expect(verifyClaims(claims, portalVerifier)).toEqual({
      ok: false,
      reason: 'organisation is not permitted here',
    });
  });

  it('binds the token to the organisation it carries', async () => {
    const { outputs, portalVerifier } = await setup();
    for (const slug of ['alpha', 'beta-two']) {
      const org = outputs.tenantOrgIds[slug]!;
      const verdict = verifyClaims(
        mint(outputs.clientIds.portal, org, ROLE_TENANT_ADMIN),
        portalVerifier
      );
      expect(verdict.ok && verdict.orgId).toBe(org);
    }
  });

  it('refuses a role granted to a different organisation than the user’s own', async () => {
    const { outputs, portalVerifier } = await setup();
    const alpha = outputs.tenantOrgIds['alpha']!;
    const beta = outputs.tenantOrgIds['beta-two']!;
    const claims = mint(outputs.clientIds.portal, alpha, ROLE_TENANT_ADMIN, {
      [CLAIM_PROJECT_ROLES]: { [ROLE_TENANT_ADMIN]: { [beta]: 'org.example.test' } },
    });
    expect(verifyClaims(claims, portalVerifier)).toEqual({
      ok: false,
      reason: 'role was not granted to the user’s organisation',
    });
  });
});

describe('verifyClaims fails closed', () => {
  const opts: VerifierOptions = {
    issuer: ISSUER,
    clientId: 'me',
    requiredRole: ROLE_TENANT_ADMIN,
    allowedOrgIds: new Set(['org-a']),
    now: NOW,
  };
  const good = (): Record<string, unknown> => {
    projectClients = ['me', 'peer'];
    return { ...mint('me', 'org-a', ROLE_TENANT_ADMIN) };
  };

  it('accepts the baseline', () => {
    expect(verifyClaims(good(), opts).ok).toBe(true);
  });

  it('accepts a single-string audience', () => {
    expect(verifyClaims({ ...good(), aud: 'me' }, opts).ok).toBe(true);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['wrong issuer', { iss: 'https://evil.example.test' }, 'issuer is not the sign-in service'],
    ['no issuer', { iss: undefined }, 'issuer is not the sign-in service'],
    ['no audience', { aud: undefined }, 'audience is missing or malformed'],
    ['numeric audience', { aud: 5 }, 'audience is missing or malformed'],
    ['mixed audience list', { aud: ['me', 5] }, 'audience is missing or malformed'],
    ['foreign audience', { aud: ['other'] }, 'token was not issued to this application'],
    ['no client_id', { client_id: undefined }, 'token was issued to a different application'],
    ['other client_id', { client_id: 'peer' }, 'token was issued to a different application'],
    ['no expiry', { exp: undefined }, 'expiry is missing'],
    ['string expiry', { exp: '9999999999' }, 'expiry is missing'],
    ['infinite expiry', { exp: Infinity }, 'expiry is missing'],
    ['expired', { exp: NOW - 1 }, 'token has expired'],
    ['expiring this second', { exp: NOW }, 'token has expired'],
    ['not yet valid', { nbf: NOW + 5 }, 'token is not yet valid'],
    ['string nbf', { nbf: 'soon' }, 'token is not yet valid'],
    ['no subject', { sub: undefined }, 'subject is missing'],
    ['empty subject', { sub: '' }, 'subject is missing'],
    ['no organisation', { [CLAIM_RESOURCE_OWNER]: undefined }, 'organisation is missing'],
    ['empty organisation', { [CLAIM_RESOURCE_OWNER]: '' }, 'organisation is missing'],
    ['no roles', { [CLAIM_PROJECT_ROLES]: undefined }, 'roles are missing'],
    ['array roles', { [CLAIM_PROJECT_ROLES]: [] }, 'roles are missing'],
    ['null roles', { [CLAIM_PROJECT_ROLES]: null }, 'roles are missing'],
    [
      'other role only',
      { [CLAIM_PROJECT_ROLES]: { owner: { 'org-a': 'x' } } },
      'role tenant-admin is missing',
    ],
    [
      'array role holders',
      { [CLAIM_PROJECT_ROLES]: { 'tenant-admin': [] } },
      'role tenant-admin is missing',
    ],
    [
      'null role holders',
      { [CLAIM_PROJECT_ROLES]: { 'tenant-admin': null } },
      'role tenant-admin is missing',
    ],
  ];
  it.each(cases)('refuses %s', (_name, patch, reason) => {
    expect(verifyClaims({ ...good(), ...patch }, opts)).toEqual({ ok: false, reason });
  });

  it('honours leeway for expiry and not-before, capped', () => {
    expect(verifyClaims({ ...good(), exp: NOW - 5 }, { ...opts, leewaySeconds: 10 }).ok).toBe(true);
    expect(verifyClaims({ ...good(), nbf: NOW + 5 }, { ...opts, leewaySeconds: 10 }).ok).toBe(true);
    expect(
      verifyClaims({ ...good(), exp: NOW - 3600 }, { ...opts, leewaySeconds: 1_000_000 }).ok
    ).toBe(false);
    expect(verifyClaims({ ...good(), exp: NOW - 5 }, { ...opts, leewaySeconds: -50 }).ok).toBe(
      false
    );
  });

  it('admits only the organisations it is given, and an empty set admits no one', () => {
    expect(verifyClaims(good(), { ...opts, allowedOrgIds: new Set(['org-a', 'org-b']) }).ok).toBe(
      true
    );
    expect(verifyClaims(good(), { ...opts, allowedOrgIds: new Set(['org-b']) }).ok).toBe(false);
    expect(verifyClaims(good(), { ...opts, allowedOrgIds: new Set() }).ok).toBe(false);
  });

  it('does not treat inherited object keys as a role grant', () => {
    const claims = { ...good(), [CLAIM_RESOURCE_OWNER]: 'toString' };
    expect(verifyClaims(claims, opts).ok).toBe(false);
  });
});
