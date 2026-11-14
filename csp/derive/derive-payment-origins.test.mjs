// node --test csp/derive/derive-payment-origins.test.mjs -- node:test only.
// The allowlist is derived, not typed, so what is tested is the refusal to
// derive from a capture that would produce a wrong or widened set: a stub
// Stripe.js, an enforced (so truncated) capture, or an origin that is not
// Stripe's; and the committed file against the derivation. Origins are
// compared as arrays, never by substring.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveOrigins, ORIGINS_PATH, renderOriginsFile } from './derive-payment-origins.mjs';

const CLI = fileURLToPath(new URL('./derive-payment-origins.mjs', import.meta.url));
const runCli = (args, capture) =>
  spawnSync(process.execPath, [CLI, ...args], { input: JSON.stringify(capture), encoding: 'utf8' });

const committed = () => JSON.parse(readFileSync(ORIGINS_PATH, 'utf-8'));

const v = (directive, blockedURI, disposition = 'report') => ({
  directive,
  blockedURI,
  disposition,
});

// What the measurement recorded: a real-JS, report-only capture whose only
// Stripe origin was js.stripe.com in script-src and frame-src.
const realCapture = {
  realStripeJs: true,
  violations: [
    v('script-src-elem', 'https://js.stripe.com/v3/'),
    v('frame-src', 'https://js.stripe.com'),
    v('frame-src', 'https://js.stripe.com'),
    v('script-src-elem', 'https://js.stripe.com/v3/'),
  ],
};

test('derives each directive from the violations, de-duplicated and sorted', () => {
  const { origins, problems } = deriveOrigins(realCapture);
  assert.deepEqual(problems, []);
  assert.deepEqual(origins, {
    'script-src': ['https://js.stripe.com'],
    'frame-src': ['https://js.stripe.com'],
    'connect-src': [],
  });
});

test('maps connect-src and keeps several origins per directive sorted', () => {
  const { origins, problems } = deriveOrigins({
    realStripeJs: true,
    violations: [
      v('connect-src', 'https://r.stripe.com/b'),
      v('connect-src', 'https://api.stripe.com/v1/x'),
      v('frame-src', 'https://m.stripe.network'),
    ],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(origins['connect-src'], ['https://api.stripe.com', 'https://r.stripe.com']);
  assert.deepEqual(origins['frame-src'], ['https://m.stripe.network']);
  assert.deepEqual(origins['script-src'], []);
});

test('refuses a stub Stripe.js capture: a stub measures nothing', () => {
  const { problems } = deriveOrigins({ ...realCapture, realStripeJs: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stub Stripe\.js/);
});

test('refuses an enforced violation: an enforcing run stops at the first block', () => {
  const { problems } = deriveOrigins({
    realStripeJs: true,
    violations: [v('script-src-elem', 'https://js.stripe.com/v3/', 'enforce')],
  });
  assert.ok(problems.some((p) => /ENFORCED, not reported/.test(p)));
});

test('refuses an origin that is not Stripe, naming it, and never adds it', () => {
  const { origins, problems } = deriveOrigins({
    realStripeJs: true,
    violations: [
      v('script-src-elem', 'https://js.stripe.com/v3/'),
      v('script-src-elem', 'https://cdn.example.test/x.js'),
      v('frame-src', 'https://js.stripe.com.example.test'),
      v('connect-src', 'https://notstripe.com'),
    ],
  });
  assert.equal(problems.length, 3);
  assert.deepEqual(origins['script-src'], ['https://js.stripe.com']);
  assert.deepEqual(origins['frame-src'], []);
  assert.deepEqual(origins['connect-src'], []);
});

test('refuses a non-https Stripe origin', () => {
  const { problems } = deriveOrigins({
    realStripeJs: true,
    violations: [v('frame-src', 'http://js.stripe.com')],
  });
  assert.ok(problems.some((p) => /not a Stripe https origin/.test(p)));
});

test('refuses an unmapped directive and a blocked URI that is not an origin', () => {
  const unmapped = deriveOrigins({
    realStripeJs: true,
    violations: [v('img-src', 'https://js.stripe.com/x.png')],
  });
  assert.ok(unmapped.problems.some((p) => /unmapped directive img-src/.test(p)));
  const inline = deriveOrigins({
    realStripeJs: true,
    violations: [v('script-src-elem', 'inline')],
  });
  assert.ok(inline.problems.some((p) => /not an origin/.test(p)));
});

test('refuses a capture that reported no Stripe origin at all', () => {
  const { problems } = deriveOrigins({ realStripeJs: true, violations: [] });
  assert.ok(problems.some((p) => /no Stripe origin at all/.test(p)));
});

test('the committed allowlist is exactly what the renderer writes for its own contents', () => {
  const text = readFileSync(ORIGINS_PATH, 'utf-8');
  assert.equal(renderOriginsFile(committed().origins), text);
  assert.deepEqual(Object.keys(committed().origins), ['script-src', 'frame-src', 'connect-src']);
});

test('the committed file equals what the derivation produces from the measured capture', () => {
  const { origins, problems } = deriveOrigins(realCapture);
  assert.deepEqual(problems, []);
  assert.equal(renderOriginsFile(origins), readFileSync(ORIGINS_PATH, 'utf-8'));
});

test('the committed allowlist carries only bare https Stripe origins: no wildcard, no path', () => {
  for (const list of Object.values(committed().origins)) {
    for (const origin of list) {
      assert.match(origin, /^https:\/\/([a-z0-9-]+\.)*stripe\.(com|network)$/);
    }
  }
});

test('--check: a capture that reproduces the committed set is green (exit 0)', () => {
  const r = runCli(['--check'], realCapture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DERIVE PAYMENT ORIGINS GREEN/);
});

test('--check control: an origin the committed file lacks is red (exit 1), showing both sets', () => {
  const capture = {
    ...realCapture,
    violations: [...realCapture.violations, v('connect-src', 'https://api.stripe.com/v1/x')],
  };
  const r = runCli(['--check'], capture);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match what the browser reported/);
  assert.match(r.stderr, /measured:/);
  assert.match(r.stderr, /committed:/);
});

test('a refused capture exits non-zero and prints nothing on stdout', () => {
  const r = runCli([], { ...realCapture, realStripeJs: false });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /DERIVE PAYMENT ORIGINS RED/);
});

test('with no flag it prints the derived file without writing it', () => {
  const r = runCli([], realCapture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, renderOriginsFile(deriveOrigins(realCapture).origins));
});
