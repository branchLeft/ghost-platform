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
