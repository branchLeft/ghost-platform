import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Claims } from '../src/tokens.js';

const url = process.env['ZITADEL_URL'] ?? '';
const tokenFile = process.env['ZITADEL_TOKEN_FILE'] ?? '';

export const instanceUrl = url;

type Json = Record<string, unknown>;

const adminToken = (): string => readFileSync(tokenFile, 'utf8').trim();

async function api(path: string, body: unknown, orgId?: string, bearer?: string): Promise<Json> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer ?? adminToken()}`,
      ...(orgId ? { 'x-zitadel-orgid': orgId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Json;
}

export interface TestUser {
  readonly userId: string;
  readonly password: string;
}

/** A human user with a random throwaway password, holding one role. A tenant
 * user's grant is made through the project grant its organisation received;
 * the owner's own user is granted the role directly. */
export async function createUser(options: {
  orgId: string;
  projectId: string;
  roleKey: string;
  projectGrantId?: string;
}): Promise<TestUser> {
  const name = `u${randomUUID().slice(0, 8)}`;
  const password = `Aa1!${randomBytes(12).toString('hex')}`;
  const created = await api(
    '/management/v1/users/human/_import',
    {
      userName: name,
      profile: { firstName: 'TEST', lastName: 'USER' },
      email: { email: `${name}@proof.test`, isEmailVerified: true },
      password,
      passwordChangeRequired: false,
    },
    options.orgId
  );
  const userId = created['userId'] as string;
  await api(
    `/management/v1/users/${userId}/grants`,
    {
      projectId: options.projectId,
      ...(options.projectGrantId ? { projectGrantId: options.projectGrantId } : {}),
      roleKeys: [options.roleKey],
    },
    options.orgId
  );
  return { userId, password };
}

export async function projectGrantId(
  ownerOrgId: string,
  projectId: string,
  grantedOrgId: string
): Promise<string> {
  const found = await api(`/management/v1/projects/${projectId}/grants/_search`, {}, ownerOrgId);
  const entry = (found['result'] as Json[]).find((grant) => grant['grantedOrgId'] === grantedOrgId);
  return entry?.['grantId'] as string;
}

let loginClient: string | undefined;

/** The v2 session and callback calls need the login-client permission, which
 * the instance owner does not hold. A machine user with exactly that role,
 * made once per run, plays the part a login UI would. */
async function loginClientToken(): Promise<string> {
  if (loginClient) return loginClient;
  const user = await api('/management/v1/users/machine', {
    userName: `login-client-${randomUUID().slice(0, 8)}`,
    name: 'login client',
    accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
  });
  const userId = user['userId'] as string;
  await api('/admin/v1/members', { userId, roles: ['IAM_LOGIN_CLIENT'] });
  const pat = await api(`/management/v1/users/${userId}/pats`, {
    expirationDate: '2030-01-01T00:00:00Z',
  });
  loginClient = pat['token'] as string;
  return loginClient;
}

export interface SignInOutcome {
  readonly claims?: Claims;
  readonly refusal?: string;
}

function decode(jwt: string): Claims {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Claims;
}

/** Checks the RS256 signature against the instance's published keys, so the
 * claims under test come from a token Zitadel really signed. */
async function assertSigned(jwt: string): Promise<void> {
  const [header, payload, signature] = jwt.split('.');
  const kid = (JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')) as Json)['kid'];
  const keys = (await (await fetch(`${url}/oauth/v2/keys`)).json()) as {
    keys: Array<Json & { kid: string }>;
  };
  const jwk = keys.keys.find((key) => key.kid === kid);
  if (!jwk) throw new Error('signing key not published');
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk as never, format: 'jwk' }),
    Buffer.from(signature ?? '', 'base64url')
  );
  if (!ok) throw new Error('token signature did not verify');
}

/** Signs a user in to one client through the real code-and-PKCE flow: an
 * authorisation request, a password session, the callback, and the token
 * exchange. Returns the access token's claims, or Zitadel's refusal. */
export async function signIn(options: {
  clientId: string;
  redirectUri: string;
  projectId: string;
  user: TestUser;
  extraScopes?: readonly string[];
}): Promise<SignInOutcome> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const scope = [
    'openid',
    'urn:zitadel:iam:org:projects:roles',
    'urn:zitadel:iam:user:resourceowner',
    `urn:zitadel:iam:org:project:id:${options.projectId}:aud`,
    ...(options.extraScopes ?? []),
  ].join(' ');
  const authorize = new URL(`${url}/oauth/v2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'proof',
  }).toString();
  const first = await fetch(authorize, { redirect: 'manual' });
  const location = first.headers.get('location') ?? '';
  if (first.status < 300 || first.status > 399 || !location) {
    return { refusal: `authorize answered ${first.status}` };
  }
  const redirected = new URL(location, url);
  if (redirected.searchParams.get('error')) {
    return { refusal: redirected.searchParams.get('error') ?? 'error' };
  }
  const authRequestId = [...redirected.searchParams.entries()].find(([key]) =>
    key.toLowerCase().startsWith('authrequest')
  )?.[1];
  if (!authRequestId) return { refusal: `no auth request in ${redirected.pathname}` };

  const login = await loginClientToken();
  const session = await api(
    '/v2/sessions',
    {
      checks: {
        user: { userId: options.user.userId },
        password: { password: options.user.password },
      },
    },
    undefined,
    login
  );
  let callback: Json;
  try {
    callback = await api(
      `/v2/oidc/auth_requests/${encodeURIComponent(authRequestId)}`,
      { session: { sessionId: session['sessionId'], sessionToken: session['sessionToken'] } },
      undefined,
      login
    );
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : 'refused' };
  }
  const callbackUrl = new URL(callback['callbackUrl'] as string);
  if (callbackUrl.searchParams.get('error')) {
    return { refusal: callbackUrl.searchParams.get('error') ?? 'error' };
  }
  const code = callbackUrl.searchParams.get('code');
  if (!code) return { refusal: 'no code in callback' };

  const exchange = await fetch(`${url}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await exchange.json()) as Json;
  if (!exchange.ok) return { refusal: String(tokens['error'] ?? exchange.status) };
  const access = tokens['access_token'] as string;
  await assertSigned(access);
  return { claims: decode(access) };
}
