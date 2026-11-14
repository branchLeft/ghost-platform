import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTokenVerifier,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
} from 'ghost-platform-identity/dist/index.js';
import { CLIENT_CONSOLE, CLIENT_PORTAL } from './idp.js';
import {
  AUTHORIZE_PATH,
  DISCOVERY_PATH,
  KEYS_PATH,
  SELECT_PATH,
  startTestIdp,
  TOKEN_PATH,
  type TestIdp,
} from './idpServer.js';

const REDIRECT = 'http://127.0.0.1:9/auth/callback';
const DEMO_ORG = 'org-demo';
const OWNER_ORG = 'org-owner-test';

let idp: TestIdp;

beforeAll(async () => {
  idp = await startTestIdp({
    users: [
      {
        id: 'demo',
        label: 'DEMO_ADMIN',
        subject: 'sub-demo',
        org: DEMO_ORG,
        role: ROLE_TENANT_ADMIN,
      },
      { id: 'owner', label: 'OWNER', subject: 'sub-owner', org: OWNER_ORG, role: ROLE_OWNER },
    ],
    clients: [
      { clientId: CLIENT_PORTAL, redirectUris: [REDIRECT] },
      { clientId: CLIENT_CONSOLE, redirectUris: [REDIRECT] },
    ],
  });
});

afterAll(async () => {
  await idp.close();
});

const challengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

function authorizeQuery(overrides: Record<string, string> = {}, verifier = 'v'.repeat(43)) {
  return new URLSearchParams({
    client_id: CLIENT_PORTAL,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid',
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    state: 'state-1',
    ...overrides,
  });
}

/** Opens the sign-in page and chooses `user`; returns the code the redirect carries. */
async function signInAs(user: string, query = authorizeQuery()): Promise<string> {
  const opened = await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${query}`);
  const request = /name="request" value="([^"]+)"/.exec(await opened.text())?.[1] ?? '';
  const chosen = await fetch(`${idp.issuer}${SELECT_PATH}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, user }),
  });
  expect(chosen.status).toBe(302);
  const target = new URL(chosen.headers.get('location') ?? '');
  expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
  expect(target.searchParams.get('state')).toBe('state-1');
  return target.searchParams.get('code') ?? '';
}

const redeem = (code: string, overrides: Record<string, string> = {}, verifier = 'v'.repeat(43)) =>
  fetch(`${idp.issuer}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_PORTAL,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      ...overrides,
    }),
  });

describe('the test identity provider over HTTP', () => {
  it('serves discovery that names its own endpoints and PKCE', async () => {
    const body = (await (await fetch(`${idp.issuer}${DISCOVERY_PATH}`)).json()) as Record<
      string,
      unknown
    >;
    expect(body['issuer']).toBe(idp.issuer);
    expect(body['authorization_endpoint']).toBe(`${idp.issuer}${AUTHORIZE_PATH}`);
    expect(body['token_endpoint']).toBe(`${idp.issuer}${TOKEN_PATH}`);
    expect(body['jwks_uri']).toBe(`${idp.issuer}${KEYS_PATH}`);
    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
  });

  it('offers a button for each user and a denial', async () => {
    const page = await (await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${authorizeQuery()}`)).text();
    expect(page).toContain('SIGN_IN_AS_DEMO_ADMIN');
    expect(page).toContain('SIGN_IN_AS_OWNER');
    expect(page).toContain('DENY_ACCESS');
  });

  it('gives a tenant administrator a token the real verifier accepts from the served keys', async () => {
    const response = await redeem(await signInAs('demo'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');
    const verifier = createTokenVerifier({
      issuer: idp.issuer,
      clientId: CLIENT_PORTAL,
      requiredRole: ROLE_TENANT_ADMIN,
      allowedOrgIds: new Set([DEMO_ORG]),
    });
    expect(await verifier.verify(body.access_token)).toEqual({
      ok: true,
      orgId: DEMO_ORG,
      subject: 'sub-demo',
    });
  });

  it('gives the owner a console token, and the portal verifier refuses it', async () => {
    const query = authorizeQuery({ client_id: CLIENT_CONSOLE });
    const response = await redeem(await signInAs('owner', query), { client_id: CLIENT_CONSOLE });
    const { access_token: token } = (await response.json()) as { access_token: string };
    const console = createTokenVerifier({
      issuer: idp.issuer,
      clientId: CLIENT_CONSOLE,
      requiredRole: ROLE_OWNER,
      allowedOrgIds: new Set([OWNER_ORG]),
    });
    expect(await console.verify(token)).toEqual({
      ok: true,
      orgId: OWNER_ORG,
      subject: 'sub-owner',
    });
    const portal = createTokenVerifier({
      issuer: idp.issuer,
      clientId: CLIENT_PORTAL,
      requiredRole: ROLE_TENANT_ADMIN,
      allowedOrgIds: new Set([OWNER_ORG]),
    });
    expect((await portal.verify(token)).ok).toBe(false);
  });

  it('refuses a wrong PKCE verifier, and the code is then spent', async () => {
    const code = await signInAs('demo');
    expect((await redeem(code, {}, 'w'.repeat(43))).status).toBe(400);
    expect((await redeem(code)).status).toBe(400);
  });

  it('redeems a code once', async () => {
    const code = await signInAs('demo');
    expect((await redeem(code)).status).toBe(200);
    expect((await redeem(code)).status).toBe(400);
  });

  it('refuses a code redeemed for another client or redirect', async () => {
    expect((await redeem(await signInAs('demo'), { client_id: CLIENT_CONSOLE })).status).toBe(400);
    expect((await redeem(await signInAs('demo'), { redirect_uri: `${REDIRECT}x` })).status).toBe(
      400
    );
  });

  it('shows an error, and never redirects, for an unregistered redirect or client', async () => {
    const overrides: Record<string, string>[] = [
      { redirect_uri: 'http://127.0.0.1:9/elsewhere' },
      { client_id: 'nope' },
    ];
    for (const override of overrides) {
      const response = await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${authorizeQuery(override)}`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('refuses a request without an S256 challenge', async () => {
    const query = authorizeQuery({ code_challenge_method: 'plain' });
    expect((await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${query}`)).status).toBe(400);
  });

  it('returns access_denied to the application when the user denies', async () => {
    const opened = await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${authorizeQuery()}`);
    const request = /name="request" value="([^"]+)"/.exec(await opened.text())?.[1] ?? '';
    const chosen = await fetch(`${idp.issuer}${SELECT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request, user: '' }),
    });
    const target = new URL(chosen.headers.get('location') ?? '');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('code')).toBeNull();
  });

  it('uses a pending request once', async () => {
    const opened = await fetch(`${idp.issuer}${AUTHORIZE_PATH}?${authorizeQuery()}`);
    const request = /name="request" value="([^"]+)"/.exec(await opened.text())?.[1] ?? '';
    const post = () =>
      fetch(`${idp.issuer}${SELECT_PATH}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request, user: 'demo' }),
      });
    expect((await post()).status).toBe(302);
    expect((await post()).status).toBe(400);
  });

  it('listens on loopback alone', async () => {
    expect(new URL(idp.issuer).hostname).toBe('127.0.0.1');
  });

  it('refuses to start in production', async () => {
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(startTestIdp({ users: [], clients: [] })).rejects.toThrow(/production/);
    } finally {
      if (before === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before;
    }
  });
});
