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

  // The rules above add coverage; none may stop catching what the original single
  // field rule removed (a flag with a spaced separator, a quoted value ending in a backslash).
  it.each([
    ['a flag with a spaced equals sign', 'run --password = SECRETX9 next', 'SECRETX9'],
    ['a flag with a spaced colon', 'run --password : SECRETX9 next', 'SECRETX9'],
    ['a flag with a colon', 'run --password: SECRETX9 next', 'SECRETX9'],
    ['a flag with an equals sign and extra spaces', 'run --token=  SECRETX9 next', 'SECRETX9'],
    ['a private-key flag with a spaced equals sign', 'run --private-key = SECRETX9', 'SECRETX9'],
    ['an access-key flag with a spaced equals sign', 'run --x-access-key = SECRETX9', 'SECRETX9'],
    [
      'a double-quoted value with spaces ending in a backslash',
      'password="ab SECRETX9\\"',
      'SECRETX9',
    ],
    [
      'a double-quoted value ending in a backslash, then more text',
      'password="ab SECRETX9\\" next',
      'SECRETX9',
    ],
    [
      'a single-quoted value with spaces ending in a backslash',
      "password='ab SECRETX9\\'",
      'SECRETX9',
    ],
    ['a JSON value with spaces ending in a backslash', '{"password":"ab SECRETX9\\"}', 'SECRETX9'],
    [
      'a quoted flag value with spaces ending in a backslash',
      'run --password "ab SECRETX9\\"',
      'SECRETX9',
    ],
  ])('still removes %s', (_name, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts a flag with a spaced equals sign exactly as the field rule always did', () => {
    expect(redactSecrets('run --password = hunter2 next')).toBe(
      `run --password = ${REDACTED} next`
    );
  });

  it('redacts a quoted value ending in a backslash exactly as the field rule always did', () => {
    expect(redactSecrets('password="ab cd\\"')).toBe(`password=${REDACTED}`);
    expect(redactSecrets("password='ab cd\\'")).toBe(`password=${REDACTED}`);
  });

  // A quoted value that ends in a backslash must not swallow the next secret field on the line.
  it.each([
    [
      'a trailing backslash then a second quoted field',
      'password="ab cd\\" token="foo"',
      `password=${REDACTED} token=${REDACTED}`,
    ],
    [
      'a trailing backslash then a second quoted field (single quotes)',
      "password='ab cd\\' token='foo'",
      `password=${REDACTED} token=${REDACTED}`,
    ],
    [
      'an escaped quote then a second quoted field',
      'password="ab\\"cd" token="foo"',
      `password=${REDACTED} token=${REDACTED}`,
    ],
    [
      'an escaped quote then a second quoted field (single quotes)',
      "password='ab\\'cd' token='foo'",
      `password=${REDACTED} token=${REDACTED}`,
    ],
    [
      'three fields, two of them ending in a backslash',
      'password="a b\\" token="foo" secret="bar\\" api_key="baz"',
      `password=${REDACTED} token=${REDACTED} secret=${REDACTED} api_key=${REDACTED}`,
    ],
    [
      'three fields in single quotes, mixed with a double-quoted one',
      "password='a b\\' token=\"foo\" secret='bar\\' api_key='baz'",
      `password=${REDACTED} token=${REDACTED} secret=${REDACTED} api_key=${REDACTED}`,
    ],
    [
      'a trailing backslash then a second field after a colon',
      'password: "ab cd\\" token: "foo"',
      `password: ${REDACTED} token: ${REDACTED}`,
    ],
    [
      'a trailing backslash then a JSON field',
      '{"password":"ab cd\\","token":"foo"}',
      `{"password":${REDACTED},"token":${REDACTED}}`,
    ],
    [
      'a JSON-escaped quote then a second JSON field',
      '{"password":"ab\\"cd","token":"foo"}',
      `{"password":${REDACTED},"token":${REDACTED}}`,
    ],
  ])('removes both secrets after %s', (_name, text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  // Found by the old-against-new differential: a value glued straight onto the next field name
  // must not hide that field from the rules that removed it before.
  it.each([
    ['a value glued to the next field name', 'x-access-key=MARKA9client_secret="MARKB9"', 'MARKB9'],
    [
      'a JSON key whose value is glued to the next field',
      'password":MARKA9token="ab MARKB9"',
      'MARKB9',
    ],
    [
      'a long run that the passphrase rule would cut in two',
      'Authorization":ab MARKA9passphrase=MARKB9x-access-key":\'MARKC9\\\'',
      'MARKA9',
    ],
  ])('still removes %s', (_name, text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it('keeps a following field that is not a secret', () => {
    expect(redactSecrets('password="a" other="keep"')).toBe(`password=${REDACTED} other="keep"`);
    expect(redactSecrets('{"password":"x\\"y","note":"keep"}')).toBe(
      `{"password":${REDACTED},"note":"keep"}`
    );
  });

  it('stays fast on long quoted values that hold many words or one long word', () => {
    for (const body of ['ab '.repeat(20_000), 'a'.repeat(50_000), 'ab\\"'.repeat(12_000)]) {
      const started = performance.now();
      redactSecrets(`password="${body}" next`);
      expect(performance.now() - started).toBeLessThan(500);
    }
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

// Found by the old-against-new differential while the rules were made linear: the JWT shape must
// start at its own "eyJ", as it always did, and must still be tried at an "eyJ" that follows one a
// token shape swallowed.
describe('redactSecrets JWT shape', () => {
  it('cuts a JWT at its eyJ, leaving a glued dotted word for the credential rule', () => {
    const jwt = `eyJ${filler(11, 'a')}private_key.${filler(11, 'b')}.`;
    expect(redactSecrets(`host.exampleToken ZQ0A.ZQ1B${jwt}`)).toBe(
      `host.exampleToken ${REDACTED}${REDACTED}`
    );
  });

  it('still reads a JWT that follows an eyJ inside another token shape', () => {
    const text = `ZQ0Axoxb-ZQ1BeyJgithub_pat_eyJ${filler(11, 'a')}.QQQQQQQQQQghp_.ZQ2C${filler(11, 'b')}`;
    expect(redactSecrets(text)).toBe(`ZQ0A${REDACTED}_pat_${REDACTED}`);
  });

  it('redacts a JWT whose first part is exactly ten characters', () => {
    const jwt = `eyJ${filler(10, 'a')}.${filler(10, 'b')}.sig`;
    expect(redactSecrets(`got ${jwt} back`)).toBe(`got ${REDACTED} back`);
  });

  it('leaves an eyJ whose first part is nine characters', () => {
    const text = `got eyJ${filler(9, 'a')}.${filler(10, 'b')}.sig back`;
    expect(redactSecrets(text)).toBe(text);
  });
});

// Redaction runs on every line the controller logs, so a crafted value must not hold a request.
// Each shape below made a rule rescan a whole run of name characters from every start inside it,
// which is quadratic: seconds at 100 KB. The budget is for a loaded CI runner; linear code needs a
// few milliseconds.
describe('redactSecrets on adversarial 100 KB input', () => {
  const SIZE = 100_000;
  const repeated = (unit: string, prefix = ''): string =>
    prefix + unit.repeat(Math.ceil((SIZE - prefix.length) / unit.length));
  // The best of three, so one scheduler pause on a busy runner is not read as slow code.
  const bestOfThreeMs = (text: string): number => {
    let best = Infinity;
    for (let attempt = 0; attempt < 3 && best >= 50; attempt += 1) {
      const started = performance.now();
      redactSecrets(text);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it.each([
    ['a long run of dotted words', repeated('ab.')],
    ['a long run of longer dotted words', repeated('word.')],
    ['secret words glued together', repeated('token')],
    ['different secret words glued together', repeated('passwordsecret')],
    ['dotted secret words', repeated('token.')],
    ['dotted words around a secret word', repeated('x.token.')],
    ['glued secret flags', repeated('--token')],
    ['glued JWT openings', repeated('eyJ')],
    ['dotted words that could open a URL scheme', repeated('a.b+c-d.')],
    ['dotted words inside an open quoted value', repeated('token.', 'password="')],
    ['glued secret words after a separator', repeated('token', 'password=')],
    ['glued secret words before a separator', `${repeated('token')} =`],
  ])('finishes %s in under 50 ms', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(SIZE);
    expect(bestOfThreeMs(text)).toBeLessThan(50);
  });
});
