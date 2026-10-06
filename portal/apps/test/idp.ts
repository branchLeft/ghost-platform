import { createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { CLAIM_PROJECT_ROLES, CLAIM_RESOURCE_OWNER } from 'ghost-platform-identity/dist/index.js';

export const ISSUER = 'https://id.example.test';
export const PROJECT_ID = 'project-1';
export const CLIENT_PORTAL = 'client-portal';
export const CLIENT_CONSOLE = 'client-console';
export const OWNER_ORG = 'org-owner';
export const NOW = 1_800_000_000;

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey: KeyObject = pair.privateKey;
const exported = pair.publicKey.export({ format: 'jwk' });
const KID = 'test-key';
export const jwks = [{ ...exported, kid: KID, use: 'sig', alg: 'RS256' }];

export interface TokenSpec {
  readonly org: string;
  readonly client: string;
  readonly role: string;
  readonly subject?: string;
  readonly exp?: number;
}

/** A token signed by the test issuer, shaped as Zitadel's access tokens are. */
export function mint(spec: TokenSpec): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: [spec.client, CLIENT_PORTAL, CLIENT_CONSOLE],
      client_id: spec.client,
      sub: spec.subject ?? 'user-1',
      exp: spec.exp ?? NOW + 7200,
      [CLAIM_RESOURCE_OWNER]: spec.org,
      [CLAIM_PROJECT_ROLES]: { [spec.role]: { [spec.org]: 'domain' } },
    })
  ).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

/** The token endpoint: each code redeems once to the token it was issued for. */
export class FakeIssuer {
  readonly codes = new Map<string, string>();
  mode: 'ok' | 'down' | 'empty' | 'refuse' = 'ok';

  issue(token: string): string {
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, token);
    return code;
  }

  readonly fetch: typeof fetch = async (_url, init) => {
    if (this.mode === 'down') throw new Error('unreachable');
    if (this.mode === 'refuse') return new Response('{}', { status: 400 });
    if (this.mode === 'empty') return Response.json({});
    const body = new URLSearchParams(String(init?.body));
    const token = this.codes.get(body.get('code') ?? '');
    if (!token || !body.get('code_verifier')) return new Response('{}', { status: 400 });
    this.codes.delete(body.get('code') ?? '');
    return Response.json({ access_token: token });
  };
}
