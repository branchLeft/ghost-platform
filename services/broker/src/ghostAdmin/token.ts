/**
 * A short-lived token for Ghost's Admin API, signed with an integration's
 * Admin API key exactly as Ghost verifies it: HS256 over the hex-decoded
 * secret, `kid` naming the key, audience `/admin/`, five minutes at most.
 */
import { createHmac } from 'node:crypto';
import { isAdminApiKey } from './keyStore.js';

const LIFETIME_SECONDS = 5 * 60;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function adminApiToken(key: string, nowSeconds: number): string {
  if (!isAdminApiKey(key)) {
    throw new Error('not a Ghost Admin API key');
  }
  const [id, secret] = key.split(':') as [string, string];
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + LIFETIME_SECONDS, aud: '/admin/' })
  );
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
