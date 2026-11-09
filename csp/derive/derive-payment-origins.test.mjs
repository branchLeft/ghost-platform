// node --test csp/derive/derive-payment-origins.test.mjs -- node:test only.
// The allowlist is derived, not typed, so what is tested is the refusal to
// derive from a capture that would produce a wrong or widened set: a stub
// Stripe.js, an enforced (so truncated) capture, or an origin that is not
// Stripe's. Plus the published floor (never narrower than Stripe's own list) and
// the committed file against the derivation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deriveOrigins,
  ORIGINS_PATH,
  PUBLISHED_FLOOR,
  renderOriginsFile,
} from './derive-payment-origins.mjs';

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

test('derives each directive from the violations, de-duplicated and sorted, with the floor', () => {
  const { origins, problems } = deriveOrigins(realCapture);
  assert.deepEqual(problems, []);
  assert.deepEqual(origins, {
    'script-src': [
      'https://*.js.stripe.com',
      'https://checkout.stripe.com',
      'https://js.stripe.com',
    ],
    'frame-src': [
      'https://*.js.stripe.com',
      'https://checkout.stripe.com',
      'https://hooks.stripe.com',
      'https://js.stripe.com',
    ],
    'connect-src': ['https://api.stripe.com', 'https://checkout.stripe.com'],
  });
});

test('maps connect-src and keeps several origins per directive sorted, measured plus floor', () => {
  const { origins, problems } = deriveOrigins({
    realStripeJs: true,
    violations: [
      v('connect-src', 'https://r.stripe.com/b'),
      v('connect-src', 'https://api.stripe.com/v1/x'),
      v('frame-src', 'https://m.stripe.network'),
    ],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(origins['connect-src'], [
    'https://api.stripe.com',
    'https://checkout.stripe.com',
    'https://r.stripe.com',
  ]);
  assert.ok(origins['frame-src'].includes('https://m.stripe.network'));
  assert.ok(origins['frame-src'].includes('https://js.stripe.com'));
});

test('a measurement that misses a published source cannot narrow the policy', () => {
  const { origins } = deriveOrigins(realCapture);
  for (const [directive, sources] of Object.entries(PUBLISHED_FLOOR)) {
    for (const source of sources) {
      assert.ok(origins[directive].includes(source), `${directive} lost ${source}`);
    }
  }
});

test('refuses a capture made with the stub Stripe.js', () => {
  const { problems } = deriveOrigins({ ...realCapture, realStripeJs: false });
  assert.ok(
    problems.some((p) => /stub Stripe\.js/.test(p)),
    problems.join('\n')
  );
});

// An enforcing run stops at the first blocked script; the frames and requests
// that would have followed never happen, and the set comes out short.
test('refuses an enforced capture', () => {
  const { problems } = deriveOrigins({
    realStripeJs: true,
    violations: [v('script-src-elem', 'https://js.stripe.com/v3/', 'enforce')],
  });
  assert.ok(
    problems.some((p) => /ENFORCED/.test(p)),
    problems.join('\n')
  );
});

// The widening risk: a hostile or accidental third-party request in the
// capture must not become an allowed origin.
test('control: an origin outside Stripe is reported, never added', () => {
  const { origins, problems } = deriveOrigins({
    realStripeJs: true,
    violations: [
      v('script-src-elem', 'https://js.stripe.com/v3/'),
      v('script-src-elem', 'https://evil.example/x.js'),
      v('script-src-elem', 'https://notstripe.com/x.js'),
      v('script-src-elem', 'https://stripe.com.evil.example/x.js'),
    ],
  });
  assert.deepEqual(origins['script-src'], [
    'https://*.js.stripe.com',
    'https://checkout.stripe.com',
    'https://js.stripe.com',
  ]);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => /not a Stripe https origin/.test(p)));
});

test('refuses a non-https Stripe origin and inline violations', () => {
  const { problems } = deriveOrigins({
    realStripeJs: true,
    violations: [v('script-src-elem', 'http://js.stripe.com/v3/'), v('script-src-elem', 'inline')],
  });
  assert.equal(problems.length, 2);
});

test('reports an unmapped directive instead of ignoring it', () => {
  const { problems } = deriveOrigins({
    realStripeJs: true,
    violations: [v('font-src', 'https://js.stripe.com/f')],
  });
  assert.ok(problems.some((p) => /unmapped directive font-src/.test(p)));
});

test('refuses a capture that reported no Stripe origin at all', () => {
  const { problems } = deriveOrigins({ realStripeJs: true, violations: [] });
  assert.ok(problems.some((p) => /no Stripe origin at all/.test(p)));
});

// Stripe's own list, as fetched 2026-11-09 from docs.stripe.com/security/guide.
// Every source here must stay in the committed file: removing one from the JSON
// (or from the floor) turns this red.
test('each published Stripe source is present in the committed allowlist', () => {
  const { origins } = committed();
  for (const [directive, sources] of Object.entries(PUBLISHED_FLOOR)) {
    for (const source of sources) {
      assert.ok(
        origins[directive].includes(source),
        `payments-origins.json ${directive} is missing the published ${source}`
      );
    }
  }
  assert.ok(origins['script-src'].includes('https://*.js.stripe.com'));
  assert.ok(origins['frame-src'].includes('https://hooks.stripe.com'));
  assert.ok(origins['connect-src'].includes('https://api.stripe.com'));
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

test('the committed allowlist carries only https Stripe origins, wildcard only as *.<host>', () => {
  for (const list of Object.values(committed().origins)) {
    for (const origin of list) {
      assert.match(origin, /^https:\/\/((\*|[a-z0-9-]+)\.)*stripe\.(com|network)$/);
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
    violations: [
      ...realCapture.violations,
      { directive: 'connect-src', blockedURI: 'https://r.stripe.com/b', disposition: 'report' },
    ],
  };
  const r = runCli(['--check'], capture);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match what the browser reported/);
  assert.match(r.stderr, /https:\/\/r\.stripe\.com/);
});

test('--check: a stub-JS capture is refused even when its origins would match', () => {
  const r = runCli(['--check'], { ...realCapture, realStripeJs: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stub Stripe\.js/);
});
