/**
 * A short-lived token for Ghost's Admin API, signed with an integration's
 * Admin API key exactly as Ghost verifies it: HS256 over the hex-decoded
 * secret, `kid` naming the key, audience `/admin/`, five minutes at most.
 *
 * This file is the only place in the repo that mints the recipe. A test
 * (test/singleHome.test.js) fails if any other source file does.
 */
import { createHmac } from 'node:crypto';
import { isAdminApiKey } from './key.js';

const LIFETIME_SECONDS = 5 * 60;

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * @param {string} key an Admin API key, `id:secret`
 * @param {number} nowSeconds
 * @returns {string}
 */
export function adminApiToken(key, nowSeconds) {
  if (!isAdminApiKey(key)) {
    // The message never carries the value: a mistyped key is still a key.
    throw new Error('not a Ghost Admin API key');
  }
  const [id, secret] = key.split(':');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + LIFETIME_SECONDS, aud: '/admin/' })
  );
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
