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

// Shapes no emitter prints today; each is a secret in a form the first
// redactor did not cover. Every value is an obvious fake.
test('a cookie inside an escaped JSON string is replaced', () => {
  const out = redact('{"log":"{\\"cookie\\":\\"ghost-admin.session=esc-c00kie-FAKE\\"}"}', []);
  assert.equal(out.includes('esc-c00kie-FAKE'), false, out);
});

test('an Authorization header with any other scheme is replaced', () => {
  const out = redact('Authorization: Token t0ken-scheme-FAKE-123', []);
  assert.equal(out.includes('t0ken-scheme-FAKE-123'), false, out);
});

test('a magic-link token after an HTML-escaped ampersand is replaced', () => {
  const out = redact(
    'href="https://gate.example.test/?action=signin&amp;token=amp-t0ken-FAKE"',
    []
  );
  assert.equal(out.includes('amp-t0ken-FAKE'), false, out);
  assert.ok(out.includes('action=signin'), out);
});

test('a magic link percent-encoded inside another URL is replaced', () => {
  const out = redact(
    'https://redirect.example.test/go?u=https%3A%2F%2Fgate.example.test%2F%3Faction%3Dsignin%26token%3Dpct-t0ken-FAKE&x=1',
    []
  );
  assert.equal(out.includes('pct-t0ken-FAKE'), false, out);
});

test('the base64 of a secret with its padding stripped is replaced', () => {
  const secret = 'pad-key-0123456789abcdef-FAKE';
  const padded = b64(secret);
  assert.ok(padded.endsWith('='), 'the fixture must need padding');
  const stripped = padded.replace(/=+$/, '');
  const out = redact(`seen ${stripped} here`, [secret]);
  assert.equal(out.includes(stripped), false, out);
});

test('headers in the rawHeaders array form are replaced', () => {
  const out = redact(
    "rawHeaders: [ 'Host', 'x.example.test', 'Cookie', 'ghost-admin.session=raw-c00kie-FAKE', 'Authorization', 'Token raw-t0ken-FAKE' ]",
    []
  );
  assert.equal(out.includes('raw-c00kie-FAKE'), false, out);
  assert.equal(out.includes('raw-t0ken-FAKE'), false, out);
  assert.ok(out.includes('x.example.test'), out);
});

// The bare form: a value with no scheme word, followed by more text. It must not be read as a
// scheme, which would show the value and hide the next word.
test('a bare Authorization value is replaced and the text after it is kept', () => {
  const out = redact('Authorization: key-0123456789abcdefFAKE\r\nHost: x.example.test', []);
  assert.equal(out.includes('key-0123456789abcdefFAKE'), false, out);
  assert.ok(out.includes('Host: x.example.test'), out);
  const inline = redact('authorization: deadbeefcafeFAKE status=401', []);
  assert.equal(inline.includes('deadbeefcafeFAKE'), false, inline);
});

test('Set-Cookie as a JSON array or an inspected array is replaced, every element', () => {
  const json = redact(
    '{"set-cookie":["sess-one=c00kie-ONE-FAKE; Path=/","sess-two=c00kie-TWO-FAKE"]}',
    []
  );
  assert.equal(json.includes('c00kie-ONE-FAKE'), false, json);
  assert.equal(json.includes('c00kie-TWO-FAKE'), false, json);
  const inspected = redact("{ 'set-cookie': [ 'sess=c00kie-INSP-FAKE; Path=/' ] }", []);
  assert.equal(inspected.includes('c00kie-INSP-FAKE'), false, inspected);
});

test('a util.inspect Map entry for a cookie is replaced', () => {
  const out = redact("Map(1) { 'cookie' => 'sess=c00kie-MAP-FAKE' }", []);
  assert.equal(out.includes('c00kie-MAP-FAKE'), false, out);
});

test('a token in a fragment, a double-encoded link or a JSON key is replaced', () => {
  for (const text of [
    'https://x.example.test/#token=frag-t0ken-FAKE',
    'https://x.example.test/go?u=https%253A%252F%252Fx.example.test%252F%253Ftoken%253Ddbl-t0ken-FAKE',
    '{"token":"json-t0ken-FAKE","other":1}',
    '{"log":"{\\"token\\":\\"esc-json-t0ken-FAKE\\"}"}',
  ]) {
    const out = redact(text, []);
    assert.equal(/frag-t0ken|dbl-t0ken|json-t0ken|esc-json-t0ken/.test(out), false, out);
  }
});

test('an AUTH PLAIN payload on the line after the command is replaced', () => {
  const payload = b64(`\u0000harness@example.com\u0000plain-pass-FAKE`);
  const out = redact(`C: AUTH PLAIN\r\nS: 334 \r\nC: ${payload}\r\nS: 235 ok`, []);
  assert.equal(out.includes(payload), false, out);
  assert.ok(out.includes('S: 235 ok'), out);
});

test('the base64 of a secret needing two padding characters, unpadded, is replaced', () => {
  const secret = 'two-pad-key-0123456789abcdef-FA'; // 31 bytes: base64 ends in ==
  const padded = b64(secret);
  assert.ok(padded.endsWith('=='), 'the fixture must need two padding characters');
  const stripped = padded.replace(/=+$/, '');
  const out = redact(`seen ${stripped} here`, [secret]);
  assert.equal(out.includes(stripped), false, out);
});
