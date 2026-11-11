import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/redact.js';

// Secret-shaped values are built at run time so no scanner sees a literal token here.
const filler = (n: number, ch = 'a'): string => ch.repeat(n);
const GITHUB_TOKEN = `ghp_${filler(36, 'Q')}`;
const FINE_GRAINED = `github_pat_${filler(40, 'Z')}`;
const API_KEY = `sk-${filler(30, 'x')}`;
const AWS_KEY = `AKIA${filler(16, 'B')}`;
const JWT = `eyJ${filler(20, 'h')}.${filler(20, 'p')}.${filler(20, 's')}`;
const HEX_RUN = filler(40, 'f');

describe('redactSecrets', () => {
  it.each([
    ['a GitHub token', `call failed with ${GITHUB_TOKEN} rejected`, GITHUB_TOKEN],
    ['a fine-grained GitHub token', `bad credential ${FINE_GRAINED}`, FINE_GRAINED],
    ['an API key by its prefix', `denied for ${API_KEY}`, API_KEY],
    ['a cloud access key id', `no such key ${AWS_KEY}`, AWS_KEY],
    ['a JWT', `token ${JWT} expired`, JWT],
    ['a long opaque run', `digest ${HEX_RUN} unknown`, HEX_RUN],
    ['a bearer credential', `header Bearer ${filler(12, 'k')} refused`, filler(12, 'k')],
    ['a value after a secret-named field (=)', 'retry with password=hunter2zz', 'hunter2zz'],
    ['a value after a secret-named field (:)', 'api_key: shortvalue1', 'shortvalue1'],
    ['a quoted value after a token field', 'token="has spaces inside"', 'has spaces inside'],
    ['a URL password', 'dial https://user:pw0rdvalue@host.example.invalid/x failed', 'pw0rdvalue'],
    [
      'a private key block',
      `-----BEGIN PRIVATE KEY-----\n${filler(30, 'm')}\n-----END PRIVATE KEY-----`,
      filler(30, 'm'),
    ],
    [
      'a private key block that never ends',
      `-----BEGIN PRIVATE KEY-----\n${filler(30, 'n')}`,
      filler(30, 'n'),
    ],
  ])('removes %s', (_name, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it.each([
    ['a JSON password', '{"password":"hunter2"}', 'hunter2'],
    ['a JSON token', '{"token":"abc12345"}', 'abc12345'],
    ['a JSON camelCase api key', '{"apiKey":"k3y-short"}', 'k3y-short'],
    ['a JSON client secret', '{"client_secret":"s3cr3tvalue"}', 's3cr3tvalue'],
    ['a JSON value after a space', '{"password": "hunter2"}', 'hunter2'],
    [
      'a JSON secret inside a longer body',
      '{"error":"denied","token":"abc12345","step":3}',
      'abc12345',
    ],
    ['a Python-repr password', "{'password': 'hunter2'}", 'hunter2'],
    ['a flag with a space', 'ssh failed: --password hunter2', 'hunter2'],
    ['a flag with a space and a token', 'run --token abc12345 --verbose', 'abc12345'],
    ['a flag with a quoted value', 'run --password "has spaces inside"', 'has spaces inside'],
    ['a flag with an equals sign', 'run --password=hunter2', 'hunter2'],
    ['a secret word with no separator', 'invalid token abc12345def', 'abc12345def'],
    ['a passphrase field', 'unlock with passphrase=hunter2', 'hunter2'],
    ['a JSON passphrase', '{"passphrase":"hunter2"}', 'hunter2'],
    ['an Authorization Token header', 'Authorization: Token abcdef123456', 'abcdef123456'],
    ['an Authorization Bearer header', 'Authorization: Bearer abcdef123456', 'abcdef123456'],
    ['an Authorization Basic header', 'authorization: Basic abcdef123456', 'abcdef123456'],
    ['a JSON Authorization header', '{"Authorization":"Token abcdef123456"}', 'abcdef123456'],
  ])('removes %s', (_name, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('keeps the field name and the shape around a JSON secret', () => {
    expect(redactSecrets('{"token":"abc12345","step":3}')).toBe(`{"token":${REDACTED},"step":3}`);
  });

  it('keeps the scheme of an Authorization header so the reader can see what failed', () => {
    expect(redactSecrets('Authorization: Token abcdef123456')).toBe(
      `Authorization: Token ${REDACTED}`
    );
  });

  it.each([
    ['an escaped quote inside a JSON value', '{"password":"ab\\"SECRETX9"}', 'SECRETX9'],
    ['an escaped quote inside a Python-repr value', "{'password': 'ab\\'SECRETX9'}", 'SECRETX9'],
    ['an escaped backslash before the tail', '{"password":"ab\\\\SECRETX9"}', 'SECRETX9'],
    ['a value ending in an escaped quote', '{"token":"SECRETX9\\""}', 'SECRETX9'],
    ['an escaped quote in a quoted flag value', 'run --password "ab\\"SECRETX9"', 'SECRETX9'],
    ['an Authorization Hmac header', 'Authorization: Hmac abcdef123456', 'abcdef123456'],
    ['an Authorization OAuth header', 'Authorization: OAuth abcdef123456', 'abcdef123456'],
  ])('removes %s', (_name, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('removes a whole escaped JSON value and keeps what follows it', () => {
    expect(redactSecrets('{"password":"ab\\"SECRETX9","step":3}')).toBe(
      `{"password":${REDACTED},"step":3}`
    );
  });

  it('keeps the scheme of an Authorization Hmac or OAuth header', () => {
    expect(redactSecrets('Authorization: Hmac abcdef123456')).toBe(
      `Authorization: Hmac ${REDACTED}`
    );
    expect(redactSecrets('Authorization: OAuth abcdef123456')).toBe(
      `Authorization: OAuth ${REDACTED}`
    );
  });

  it('stays fast on a long run of dashes', () => {
    const text = '-'.repeat(50_000);
    const started = performance.now();
    redactSecrets(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([
    'token expired for host-one.example.invalid (step 3)',
    'the password policy rejected the request',
    'passphrase required',
    'invalid token',
    'bad token format at step 3',
    'run --verbose --timeout 30 --retries 3',
    '{"status":"failed","step":3,"host":"host-one.example.invalid"}',
    "{'status': 'failed', 'step': 3}",
    'Authorization header missing',
    'HTTP 401 Unauthorized from https://host-one.example.invalid/v1/things',
  ])('leaves %j readable', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves an ordinary diagnostic readable', () => {
    const text = 'ConnectionError: connect ECONNREFUSED host-one.example.invalid:5432 (step 3)';
    expect(redactSecrets(text)).toBe(text);
  });

  it('keeps the name of a secret field so the reader can see what failed', () => {
    expect(redactSecrets('password=hunter2zz')).toBe(`password=${REDACTED}`);
  });

  it('redacts every occurrence, not only the first', () => {
    const out = redactSecrets(`${GITHUB_TOKEN} and again ${GITHUB_TOKEN}`);
    expect(out).not.toContain('ghp_');
  });
});
