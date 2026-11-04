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
