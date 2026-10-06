import { createHash, randomBytes } from 'node:crypto';

/** What the portal asks Zitadel for: the roles and the user's organisation must
 * be in the token, and the project audience makes it a token for this project. */
export function scopesFor(projectId: string): string {
  return [
    'openid',
    'urn:zitadel:iam:org:projects:roles',
    'urn:zitadel:iam:user:resourceowner',
    `urn:zitadel:iam:org:project:id:${projectId}:aud`,
  ].join(' ');
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function newPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface OidcClient {
  readonly issuer: string;
  readonly clientId: string;
  readonly projectId: string;
  readonly redirectUri: string;
}

const trimSlash = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url);

export function authorizeUrl(client: OidcClient, state: string, challenge: string): string {
  const url = new URL(`${trimSlash(client.issuer)}/oauth/v2/authorize`);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: scopesFor(client.projectId),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
}

/** Exchanges the code for the access token. Any failure is null, never a detail. */
export async function exchangeCode(
  client: OidcClient,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${trimSlash(client.issuer)}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: unknown };
    return typeof body.access_token === 'string' && body.access_token.length > 0
      ? body.access_token
      : null;
  } catch {
    return null;
  }
}

/** The `exp` of a token whose signature has already been verified. */
export function expiryOf(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    );
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}
