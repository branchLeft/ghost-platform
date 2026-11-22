// The gate dumps the Ghost and spool logs when a check fails, so a red job log
// names its cause. Those logs must not carry the spool key or the
// drain token. No Docker: this tests the redactor alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './mail-gate.mjs';

const KEY = 'k3y-0123456789abcdef0123456789abcdef0123456789abcdef';
const TOKEN = 'dr41n-token-0123456789abcdef0123456789abcdef';

test('a secret is replaced wherever it appears', () => {
  const out = redact(`sent with ${KEY} and again ${KEY}; drain ${TOKEN}`, [KEY, TOKEN]);
  assert.doesNotMatch(out, new RegExp(KEY));
  assert.doesNotMatch(out, new RegExp(TOKEN));
  assert.equal(out.match(/\[redacted\]/g).length, 3);
});

test('an Authorization header value is replaced even when it is not a known secret', () => {
  const basic = Buffer.from('api:something-else').toString('base64');
  assert.doesNotMatch(redact(`Authorization: Basic ${basic}`, []), new RegExp(basic));
  assert.doesNotMatch(redact('authorization: Bearer abc.def-123', []), /abc\.def-123/);
  assert.doesNotMatch(redact('{"authorization":"Bearer abc.def-123"}', []), /abc\.def-123/);
});

test('ordinary log text and the shim reply pass through unchanged', () => {
  const line = `mailgun 400 {"message":"'from' address must belong to the domain gate-slot0.example.com"}`;
  assert.equal(redact(line, [KEY]), line);
});

test('an empty secret does not blank the text', () => {
  assert.equal(redact('hello', ['', undefined]), 'hello');
});

const b64 = (s) => Buffer.from(s).toString('base64');

test('the base64 of the spool key alone is replaced', () => {
  const encoded = b64(KEY);
  const out = redact(`key as base64 ${encoded} in a log line`, [KEY]);
  assert.equal(out.includes(encoded), false, out);
});

test('an SMTP AUTH PLAIN payload is replaced', () => {
  const payload = b64(`\u0000harness@example.com\u0000${KEY}`);
  const out = redact(`C: AUTH PLAIN ${payload}`, []);
  assert.equal(out.includes(payload), false, out);
});

test('Cookie and Set-Cookie values are replaced', () => {
  const out = redact(
    'Cookie: ghost-admin.session=c00kie-session-value\nSet-Cookie: ghost-members-ssr=set-cookie-value; Path=/; HttpOnly',
    []
  );
  assert.equal(out.includes('c00kie-session-value'), false, out);
  assert.equal(out.includes('set-cookie-value'), false, out);
});

test('a magic-link token query value is replaced, the rest of the link is kept', () => {
  const out = redact(
    'link https://gate-slot0.example.com/?token=m4g1c-l1nk-t0ken&action=signin sent',
    []
  );
  assert.equal(out.includes('m4g1c-l1nk-t0ken'), false, out);
  assert.ok(out.includes('action=signin'), out);
});

test('the spool key in upper case is replaced', () => {
  const upper = KEY.toUpperCase();
  const out = redact(`key ${upper} seen`, [KEY]);
  assert.equal(out.includes(upper), false, out);
});

test('an authorization value inside an escaped JSON string is replaced', () => {
  const out = redact('{"log":"{\\"authorization\\":\\"Bearer esc.aped-t0ken-99\\"}"}', []);
  assert.equal(out.includes('esc.aped-t0ken-99'), false, out);
});

test('an Authorization: Ghost token is replaced', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE2MDAwMDAwMDB9.ghostSigPart-123';
  const out = redact(`Authorization: Ghost ${jwt}`, []);
  assert.equal(out.includes(jwt), false, out);
  assert.equal(out.includes('eyJ'), false, out);
});

// Shapes no emitter prints today; each is a secret in a form the first redactor
// did not cover. Every value is an obvious fake.
test('a cookie inside an escaped JSON string is replaced', () => {
  const out = redact('{"log":"{\\"cookie\\":\\"ghost-admin.session=esc-c00kie-FAKE\\"}"}', []);
  assert.equal(out.includes('esc-c00kie-FAKE'), false, out);
});

test('a set-cookie array, as JSON or as util.inspect prints it, is replaced', () => {
  const json = redact(
    '{"set-cookie":["ghost-admin-api-session=arr-one-FAKE; Path=/","b=arr-two-FAKE"]}',
    []
  );
  assert.equal(json.includes('arr-one-FAKE'), false, json);
  assert.equal(json.includes('arr-two-FAKE'), false, json);
  const inspected = redact(
    "{ 'set-cookie': [ 'ghost-admin-api-session=arr-three-FAKE; Path=/' ] }",
    []
  );
  assert.equal(inspected.includes('arr-three-FAKE'), false, inspected);
  assert.ok(inspected.trimEnd().endsWith('}'), inspected);
  // util.inspect and JSON.stringify(_, null, 2) break a long array over several lines.
  const wrapped = redact(
    "{\n  'set-cookie': [\n    'ghost-admin-api-session=wrap-one-FAKE; Path=/',\n    'b=wrap-two-FAKE'\n  ],\n  host: 'x.example.test'\n}",
    []
  );
  assert.equal(wrapped.includes('wrap-one-FAKE'), false, wrapped);
  assert.equal(wrapped.includes('wrap-two-FAKE'), false, wrapped);
  assert.ok(wrapped.includes("host: 'x.example.test'"), wrapped);
});

test('an Authorization header with any other scheme is replaced', () => {
  const out = redact('Authorization: Token t0ken-scheme-FAKE-123', []);
  assert.equal(out.includes('t0ken-scheme-FAKE-123'), false, out);
});

test('a bare Authorization value is replaced, whatever follows it', () => {
  const crlf = redact('Authorization: key-0123456789abcdefFAKE\r\nHost: x.example.test', []);
  assert.equal(crlf.includes('key-0123456789abcdefFAKE'), false, crlf);
  assert.ok(crlf.includes('Host: x.example.test'), crlf);
  const sameLine = redact('authorization: deadbeefcafe-FAKE status=401', []);
  assert.equal(sameLine.includes('deadbeefcafe-FAKE'), false, sameLine);
});

test('a magic-link token after an HTML-escaped ampersand is replaced', () => {
  const out = redact(
    'href="https://gate.example.test/?action=signin&amp;token=amp-t0ken-FAKE&amp;x=1"',
    []
  );
  assert.equal(out.includes('amp-t0ken-FAKE'), false, out);
  assert.ok(out.includes('action=signin'), out);
  assert.ok(out.includes('x=1'), out);
});

test('a magic link percent-encoded inside another URL is replaced, once or twice encoded', () => {
  const once = redact(
    'https://redirect.example.test/go?u=https%3A%2F%2Fgate.example.test%2F%3Faction%3Dsignin%26token%3Dpct-t0ken-FAKE%26x%3D1&y=2',
    []
  );
  assert.equal(once.includes('pct-t0ken-FAKE'), false, once);
  assert.ok(once.includes('action%3Dsignin'), once);
  assert.ok(once.includes('x%3D1'), once);
  const twice = redact(
    'https://r.example.test/go?u=https%253A%252F%252Fg.example.test%252F%253Ftoken%253Dtwice-FAKE',
    []
  );
  assert.equal(twice.includes('twice-FAKE'), false, twice);
});

test('the base64 of a secret with its padding stripped is replaced', () => {
  // One `=` of padding (29 bytes) and two (28 bytes).
  for (const secret of ['pad-key-0123456789abcdef-FAKE', 'pad-key-0123456789abcdef-FAK']) {
    const padded = b64(secret);
    assert.ok(padded.endsWith('='), 'the fixture must need padding');
    const stripped = padded.replace(/=+$/, '');
    const out = redact(`seen ${stripped} here`, [secret]);
    assert.equal(out.includes(stripped), false, out);
  }
});

test('headers in the rawHeaders array form are replaced', () => {
  const out = redact(
    "rawHeaders: [ 'Host', 'x.example.test', 'Cookie', 'ghost-admin.session=raw-c00kie-FAKE', 'Authorization', 'Token raw-t0ken-FAKE', 'Accept', '*/*' ]",
    []
  );
  assert.equal(out.includes('raw-c00kie-FAKE'), false, out);
  assert.equal(out.includes('raw-t0ken-FAKE'), false, out);
  assert.ok(out.includes('x.example.test'), out);
  assert.ok(out.includes("'Accept', '*/*'"), out);
});

test('text that only looks like the new shapes passes through unchanged', () => {
  for (const line of [
    'href="https://gate.example.test/?action=signin&amp;x=1"',
    'refreshed the session token for slot0',
    'https://r.example.test/go?u=https%3A%2F%2Fg.example.test%2F%3Faction%3Dsignin&y=2',
    "rawHeaders: [ 'Host', 'x.example.test', 'Accept', '*/*' ]",
  ]) {
    assert.equal(redact(line, []), line);
  }
});

// Sibling spellings of the shapes above, one test each. Every value is an obvious fake.
test('a set_cookie key with an underscore is replaced', () => {
  const out = redact('{"set_cookie":"ghost-admin.session=under-score-FAKE; Path=/"}', []);
  assert.equal(out.includes('under-score-FAKE'), false, out);
});

test('a cookies key, in the plural, is replaced', () => {
  const out = redact('cookies: ghost-admin.session=plural-FAKE', []);
  assert.equal(out.includes('plural-FAKE'), false, out);
});

test('a quoted Cookie value is replaced to its closing quote', () => {
  const out = redact('Cookie: a="quoted-FAKE"', []);
  assert.equal(out.includes('quoted-FAKE'), false, out);
});

test('a `]` inside a cookie array element does not end the redaction early', () => {
  const out = redact('{"set-cookie":["a=arr-ten]FAKE-tail; Path=/","b=after-FAKE"]}', []);
  assert.equal(out.includes('FAKE-tail'), false, out);
  assert.equal(out.includes('after-FAKE'), false, out);
});

test('a Digest Authorization value is replaced in every parameter', () => {
  const out = redact(
    'Authorization: Digest username="dig-user", realm="r.example.test", nonce="dig-nonce-FAKE", response="dig-resp-FAKE"',
    []
  );
  assert.equal(out.includes('dig-nonce-FAKE'), false, out);
  assert.equal(out.includes('dig-resp-FAKE'), false, out);
});

test('an Authorization value after a gap of more than 8 non-word characters is replaced', () => {
  const out = redact(`authorization${'"'.repeat(12)}Bearer wide-gap-FAKE`, []);
  assert.equal(out.includes('wide-gap-FAKE'), false, out);
});

test('an Authorization value inside double-escaped JSON is replaced', () => {
  const e = '\\\\\\"'; // three backslashes and a quote: one escape level below the log's own
  const out = redact(`{"log":"{${e}authorization${e}:${e}Bearer dbl-esc-FAKE${e}}"}`, []);
  assert.equal(out.includes('dbl-esc-FAKE'), false, out);
});

test('a token after a plain ampersand is replaced', () => {
  const out = redact('https://gate.example.test/?action=signin&token=amp-plain-FAKE&x=1', []);
  assert.equal(out.includes('amp-plain-FAKE'), false, out);
  assert.ok(out.includes('x=1'), out);
});

test('a magic-link token percent-encoded three times is replaced, the rest kept', () => {
  const out = redact(
    'https://r.example.test/go?u=https%25253A%25252F%25252Fg.example.test%25252F%25253Ftoken%25253Dtriple-FAKE%252526x%25253D1',
    []
  );
  assert.equal(out.includes('triple-FAKE'), false, out);
  assert.ok(out.includes('x%25253D1'), out);
});

test('a JSON "token" key with a string value is replaced', () => {
  const out = redact('{"token":"json-tok-FAKE","expires":60}', []);
  assert.equal(out.includes('json-tok-FAKE'), false, out);
  assert.ok(out.includes('"expires":60'), out);
});
