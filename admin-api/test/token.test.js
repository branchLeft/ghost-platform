import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_API_KEY_PATTERN, adminApiToken, isAdminApiKey } from '../index.js';
import { KEY, SECRET, verifyToken } from './helpers.js';

// Minted by the broker's own adminApiToken, before the recipe moved here, for
// this fixed key and this fixed time. The moved code must reproduce it byte
// for byte; this is the proof that the move preserved behaviour.
const GOLDEN_KEY = `0123456789abcdef01234567:${'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2)}`;
const GOLDEN_NOW = 1_700_000_000;
const GOLDEN_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2NyJ9.eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAwMDMwMCwiYXVkIjoiL2FkbWluLyJ9.a72ACmu9JvgOLzAibs0UTeH8nrLpmtYBh5CcX70AI60';

test('the token matches the one the broker minted before the move, byte for byte', () => {
  assert.equal(adminApiToken(GOLDEN_KEY, GOLDEN_NOW), GOLDEN_TOKEN);
});

test('an independent verifier accepts a minted token (the green control)', () => {
  const token = adminApiToken(KEY, 1_800_000_000);
  assert.equal(verifyToken(token, KEY), true);
  assert.equal(verifyToken(adminApiToken(GOLDEN_KEY, GOLDEN_NOW), GOLDEN_KEY), true);
});

test('the verifier rejects the token once any byte of a part is flipped', () => {
  const token = adminApiToken(KEY, 1_800_000_000);
  const parts = token.split('.');
  for (const index of [0, 1, 2]) {
    const mutated = [...parts];
    const part = /** @type {string} */ (mutated[index]);
    // The first character: always significant, unlike the last of a base64url
    // part, whose unused bits can change without changing the bytes.
    mutated[index] = (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    assert.equal(verifyToken(mutated.join('.'), KEY), false, `part ${index} flipped`);
  }
});

test('the verifier rejects the token under a different secret', () => {
  const token = adminApiToken(KEY, 1_800_000_000);
  const otherSecret = SECRET.replace(/^./, SECRET[0] === '0' ? '1' : '0');
  assert.equal(verifyToken(token, KEY.replace(SECRET, otherSecret)), false);
});

test('the token lives five minutes and names the key', () => {
  const [header, payload] = adminApiToken(KEY, 1_000).split('.');
  const head = JSON.parse(Buffer.from(/** @type {string} */ (header), 'base64url').toString());
  const body = JSON.parse(Buffer.from(/** @type {string} */ (payload), 'base64url').toString());
  assert.deepEqual(head, { alg: 'HS256', typ: 'JWT', kid: KEY.split(':')[0] });
  assert.deepEqual(body, { iat: 1_000, exp: 1_300, aud: '/admin/' });
});

test('a value that is not a key throws, and the message never carries the value', () => {
  const inputs = [
    'nope-distinctive-wrong-value',
    `${KEY}x`,
    KEY.toUpperCase(),
    `${KEY}\n`,
    '',
    undefined,
    42,
    null,
  ];
  for (const input of inputs) {
    assert.throws(
      () => adminApiToken(/** @type {any} */ (input), 1),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'not a Ghost Admin API key');
        return true;
      }
    );
  }
});

test('isAdminApiKey takes a key and nothing else', () => {
  assert.equal(isAdminApiKey(KEY), true);
  assert.equal(isAdminApiKey(`${KEY}x`), false);
  assert.equal(isAdminApiKey(`${KEY}\n`), false);
  assert.equal(isAdminApiKey(/** @type {any} */ (undefined)), false);
  assert.equal(ADMIN_API_KEY_PATTERN.test(KEY), true);
});
