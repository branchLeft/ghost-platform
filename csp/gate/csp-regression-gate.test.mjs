// Tests for the content-policy regression verdict. Fixtures are the shapes
// LLD-5 05-gate-and-edge.html §04 measured (rows A, B, D) in capture-csp.mjs's
// output format.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRegression } from './csp-regression-gate.mjs';

const ATTACK = { directive: 'script-src-elem', blockedURI: 'inline' };
const rowB = {
  injectedScriptRan: false,
  portalSignInForm: 'rendered',
  emailFields: 1,
  cspViolations: [ATTACK],
};

test('row B (strict policy + hashes) passes', () => {
  assert.deepEqual(judgeRegression(rowB), []);
});

test('row A (no policy): red because the injected script ran', () => {
  const f = judgeRegression({ ...rowB, injectedScriptRan: true, cspViolations: [] });
  assert.ok(f.includes('the injected script ran'));
});

test("row D (hashes removed): red on Ghost's own inline blocks", () => {
  const f = judgeRegression({ ...rowB, cspViolations: [ATTACK, ATTACK, ATTACK] });
  assert.equal(f.length, 1);
  assert.match(f[0], /Ghost's own inline blocks/);
});

test('red when Portal did not render', () => {
  assert.ok(
    judgeRegression({ ...rowB, portalSignInForm: 'not rendered', emailFields: 0 }).length >= 1
  );
});

test('red when the one violation is not the attack', () => {
  const f = judgeRegression({
    ...rowB,
    cspViolations: [{ directive: 'img-src', blockedURI: 'https://x' }],
  });
  assert.equal(f.length, 1);
});

test('red when the run is malformed (missing fields)', () => {
  assert.ok(judgeRegression({}).length >= 2);
});

test('red when a lone violation has the wrong directive (same blocked URI)', () => {
  const f = judgeRegression({
    ...rowB,
    cspViolations: [{ directive: 'script-src-attr', blockedURI: 'inline' }],
  });
  assert.equal(f.length, 1);
});

test('red when a lone violation has the wrong blocked URI (same directive)', () => {
  const f = judgeRegression({
    ...rowB,
    cspViolations: [{ directive: 'script-src-elem', blockedURI: 'https://evil.example/x.js' }],
  });
  assert.equal(f.length, 1);
});

test('red when Portal reports rendered but found no email field', () => {
  assert.equal(judgeRegression({ ...rowB, emailFields: 0 }).length, 1);
});

test('green with more than one email field', () => {
  assert.deepEqual(judgeRegression({ ...rowB, emailFields: 2 }), []);
});
