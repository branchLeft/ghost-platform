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
