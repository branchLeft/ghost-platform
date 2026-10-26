// Tests for the content-policy regression verdict. Fixtures are the shapes
// LLD-5 05-gate-and-edge.html §04 measured (rows A, B, D) in capture-csp.mjs's
// output format.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// The CLI is only a verdict if its main block runs. A silent skip exits 0, so
// each case here must see the verdict's own output, not just an exit code.
const CLI = fileURLToPath(new URL('./csp-regression-gate.mjs', import.meta.url));

function runCli(cliPath, capture) {
  return spawnSync(process.execPath, [cliPath], {
    input: JSON.stringify(capture),
    encoding: 'utf8',
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'csp gate '));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI run from a path containing a space judges a broken capture: exit 1', () => {
  withTempDir((dir) => {
    const copy = join(dir, 'csp-regression-gate.mjs');
    copyFileSync(CLI, copy);
    const r = runCli(copy, {});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /CSP REGRESSION GATE RED/);
  });
});

test('CLI run from a path containing a space judges a holding capture: exit 0', () => {
  withTempDir((dir) => {
    const copy = join(dir, 'csp-regression-gate.mjs');
    copyFileSync(CLI, copy);
    const r = runCli(copy, rowB);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CSP REGRESSION GATE GREEN/);
  });
});

// Forces a misfire: a harness sets argv[1] to a same-named path that does not
// exist, then imports the CLI, so the guard cannot match the real file.
function runMisfired(capture) {
  return withTempDir((dir) => {
    const harness = join(dir, 'force-misfire.mjs');
    const fakeArgv1 = join(dir, 'nowhere', 'csp-regression-gate.mjs');
    writeFileSync(
      harness,
      `process.argv[1] = ${JSON.stringify(fakeArgv1)};\n` +
        `await import(${JSON.stringify(pathToFileURL(CLI).href)});\n`
    );
    return spawnSync(process.execPath, [harness], {
      input: capture === undefined ? '' : JSON.stringify(capture),
      encoding: 'utf8',
    });
  });
}

test('misfired guard with a piped holding capture fails closed: exit 1, not judged', () => {
  const r = runMisfired(rowB);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /run-as-main guard did not match/);
});

test('misfired guard with an empty stdin stays silent: exit 0', () => {
  const r = runMisfired(undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('CLI reached through a symlink judges a broken capture: exit 1', () => {
  withTempDir((dir) => {
    const link = join(dir, 'gate-link.mjs');
    symlinkSync(CLI, link);
    const r = runCli(link, {});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /CSP REGRESSION GATE RED/);
  });
});
