// node --test csp/proof/real-test-mode.test.mjs -- every refusal of the real
// Stripe TEST-mode switch, and the rule that no key value ever reaches output.
// No Docker, no browser, no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PUBLISHED_TEST_CARD,
  assertLocalTenant,
  assertPublishedTestCard,
  isTenantViolation,
  keyProblems,
  ownerCommand,
  preflight,
  redactSecrets,
  secretValues,
  usage,
} from './real-test-mode.mjs';

const MODULE = fileURLToPath(new URL('./real-test-mode.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('../gate/csp-checkout-gate.py', import.meta.url));
const ORIGIN = 'http://localhost:4321';

// Shaped like real keys but made up and assembled at run time, so no secret
// scanner (or grep for a live-key prefix) trips on this file. Each carries a
// marker so a leak of any one is found by name.
const make = (prefix, marker) => [...prefix, `${marker}${'Z'.repeat(16)}`].join('_');
const SECRET = make(['sk', 'test'], 'SecretMarkerOne');
const PUBLISHABLE = make(['pk', 'test'], 'PubMarkerTwo');
const WEBHOOK = make(['whsec'], 'HookMarkerThree');
const GOOD = {
  STRIPE_TEST_SECRET_KEY: SECRET,
  STRIPE_TEST_PUBLISHABLE_KEY: PUBLISHABLE,
  STRIPE_TEST_WEBHOOK_SECRET: WEBHOOK,
};
const LIVE_SECRET = make(['sk', 'live'], 'LiveMarkerFour');
const RESTRICTED_TEST = make(['rk', 'test'], 'RestrictedMarkerFive');
const RESTRICTED_LIVE = make(['rk', 'live'], 'RestrictedLiveMarkerSix');
const MARKERS = [
  'SecretMarker',
  'PubMarker',
  'HookMarker',
  'LiveMarker',
  'RestrictedMarker',
  'RestrictedLiveMarker',
  'BadShapeMarker',
  'OtherCardMarker',
];

function names(env) {
  return keyProblems(env).map((p) => p.name);
}

test('accepts three well-formed test-mode values and a local tenant', () => {
  assert.deepEqual(keyProblems(GOOD), []);
  const r = preflight(GOOD, ORIGIN);
  assert.equal(r.ok, true);
  assert.match(
    r.lines.join('\n'),
    /stripe listen --forward-to http:\/\/localhost:4321\/members\/webhooks\/stripe\//
  );
});

test('each missing or empty variable is refused and named', () => {
  for (const name of Object.keys(GOOD)) {
    const missing = { ...GOOD };
    delete missing[name];
    assert.deepEqual(
      keyProblems(missing),
      [{ name, problem: 'is not set or is empty' }],
      `${name} unset`
    );
    assert.deepEqual(
      keyProblems({ ...GOOD, [name]: '' }),
      [{ name, problem: 'is not set or is empty' }],
      `${name} empty`
    );
  }
});

test('a live secret key is refused', () => {
  const [p] = keyProblems({ ...GOOD, STRIPE_TEST_SECRET_KEY: LIVE_SECRET });
  assert.equal(p.name, 'STRIPE_TEST_SECRET_KEY');
  assert.match(p.problem, /LIVE secret key is refused/);
});

test('a live publishable key is refused', () => {
  const [p] = keyProblems({
    ...GOOD,
    STRIPE_TEST_PUBLISHABLE_KEY: make(['pk', 'live'], 'LiveMarkerFour'),
  });
  assert.equal(p.name, 'STRIPE_TEST_PUBLISHABLE_KEY');
  assert.match(p.problem, /LIVE publishable key is refused/);
});

test('a restricted key is refused, test or live, until a test proves it works with Ghost', () => {
  for (const value of [RESTRICTED_TEST, RESTRICTED_LIVE]) {
    const [p] = keyProblems({ ...GOOD, STRIPE_TEST_SECRET_KEY: value });
    assert.equal(p.name, 'STRIPE_TEST_SECRET_KEY');
    assert.match(p.problem, /restricted key is refused/);
  }
});

test('a secret key with the wrong shape is refused', () => {
  for (const value of [
    'sk_test_',
    'sk_test_ab-cd',
    'sk_test_ab cd',
    'xsk_test_abcd',
    `${SECRET}\n`,
    'abcd',
  ]) {
    assert.deepEqual(
      names({ ...GOOD, STRIPE_TEST_SECRET_KEY: value }),
      ['STRIPE_TEST_SECRET_KEY'],
      value
    );
  }
});

test('a webhook secret with the wrong shape is refused', () => {
  for (const value of ['whsec_', 'whsec_ab-cd', 'we_abcd', SECRET, `${WEBHOOK} `]) {
    assert.deepEqual(
      names({ ...GOOD, STRIPE_TEST_WEBHOOK_SECRET: value }),
      ['STRIPE_TEST_WEBHOOK_SECRET'],
      value
    );
  }
});

test('a publishable key with the secret-key shape is refused', () => {
  assert.deepEqual(names({ ...GOOD, STRIPE_TEST_PUBLISHABLE_KEY: SECRET }), [
    'STRIPE_TEST_PUBLISHABLE_KEY',
  ]);
});

test('only a local http tenant with a port is accepted', () => {
  assert.doesNotThrow(() => assertLocalTenant('http://localhost:4321'));
  assert.doesNotThrow(() => assertLocalTenant('http://127.0.0.1:4321'));
  for (const origin of [
    'https://example.com',
    'http://example.com:4321',
    'http://localhost.example.com:4321',
    'http://localhost@example.com:4321',
    'http://127.0.0.1.example.com:4321',
    'https://localhost:4321',
    'http://localhost',
    'http://192.168.1.10:4321',
    'http://0.0.0.0:4321',
    'not a url',
    undefined,
  ]) {
    assert.throws(() => assertLocalTenant(origin), /refusing/, String(origin));
  }
});

test('preflight refuses a non-local tenant even with good keys', () => {
  const r = preflight(GOOD, 'https://tenant.example.com');
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /local disposable tenant/);
});

test('any card number other than the published test card is refused', () => {
  assert.equal(assertPublishedTestCard('4242 4242 4242 4242'), PUBLISHED_TEST_CARD);
  assert.equal(assertPublishedTestCard('4242424242424242'), PUBLISHED_TEST_CARD);
  for (const card of [
    '4000 0000 0000 0002',
    '5555 5555 5555 4444',
    '4242 4242 4242 4241',
    '',
    undefined,
    4242,
  ]) {
    assert.throws(() => assertPublishedTestCard(card), /published test card/, String(card));
  }
  const r = preflight({ ...GOOD, CSP_STRIPE_TEST_CARD: '4000 0000 0000 0002' }, ORIGIN);
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /CSP_STRIPE_TEST_CARD/);
});

// The log-path rule. Each case runs the real CLI with distinctive values and
// requires that none of them, nor any marker, appears in either stream.
const LEAK_CASES = {
  'all good': { ...GOOD },
  'live key': { ...GOOD, STRIPE_TEST_SECRET_KEY: LIVE_SECRET },
  'restricted test key': { ...GOOD, STRIPE_TEST_SECRET_KEY: RESTRICTED_TEST },
  'restricted live key': { ...GOOD, STRIPE_TEST_SECRET_KEY: RESTRICTED_LIVE },
  'wrong shape secret': { ...GOOD, STRIPE_TEST_SECRET_KEY: 'sk_test_BadShapeMarker-bad' },
  'wrong shape webhook': { ...GOOD, STRIPE_TEST_WEBHOOK_SECRET: 'we_BadShapeMarkerHook' },
  'unrecognised publishable': { ...GOOD, STRIPE_TEST_PUBLISHABLE_KEY: 'BadShapeMarkerPub' },
  'other card': { ...GOOD, CSP_STRIPE_TEST_CARD: '4000 0000 OtherCardMarker' },
};

function runModule(args, env, input) {
  return spawnSync(process.execPath, [MODULE, ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, ...env },
  });
}

test('no key value, and no marker of one, appears in any output of a refusal or an accept', () => {
  for (const [label, env] of Object.entries(LEAK_CASES)) {
    const r = runModule(['preflight', '--origin', ORIGIN], env);
    const seen = `${r.stdout}\n${r.stderr}`;
    for (const value of Object.values(env)) {
      if (value !== '')
        assert.ok(!seen.includes(value), `${label}: a value appeared in the output`);
    }
    for (const marker of MARKERS) assert.ok(!seen.includes(marker), `${label}: ${marker} appeared`);
    assert.equal(r.status, label === 'all good' ? 0 : 2, label);
  }
});

test('a refusal exits non-zero and prints the full owner command from names that exist', () => {
  const r = runModule(['preflight', '--origin', ORIGIN], {});
  assert.equal(r.status, 2);
  for (const name of Object.keys(GOOD))
    assert.match(r.stderr, new RegExp(`${name}: is not set or is empty`));
  assert.ok(r.stderr.includes(ownerCommand()), 'the whole owner command block');
  assert.match(r.stderr, /stripe listen --print-secret/);
});

test('the owner command names only variables the gate reads and a script that exists', () => {
  assert.ok(existsSync(GATE));
  const block = ownerCommand();
  assert.equal(block.split('\n').length, 4);
  for (const name of Object.keys(GOOD))
    assert.match(block, new RegExp(`read -rs ${name}; export ${name}`));
  assert.match(block, /^CSP_STRIPE_REAL_TEST_MODE=1 csp\/gate\/csp-checkout-gate\.py$/m);
  assert.doesNotMatch(usage(), /\/Users\//);
});

test('redaction removes key-shaped strings, known values, and the checkout URL fragment', () => {
  const text = `a ${SECRET} b ${PUBLISHABLE} c ${WEBHOOK} d ${LIVE_SECRET} e ${RESTRICTED_TEST}`;
  const out = redactSecrets(text);
  for (const marker of MARKERS) assert.ok(!out.includes(marker), marker);
  const odd = 'not-key-shaped-but-known-value-12345';
  assert.equal(redactSecrets(`x ${odd} y`, [odd]), 'x [REDACTED] y');
  const url = 'https://checkout.stripe.com/c/pay/cs_test_abc#fidkdWxOYHwnPyd1blpxYHZxWjA0';
  assert.equal(
    redactSecrets(`waiting for ${url} done`),
    'waiting for https://checkout.stripe.com/c/pay/cs_test_abc#[REDACTED] done'
  );
});

test('the redact CLI scrubs a captured run that echoed a key, including values only the environment knows', () => {
  const odd = 'unshaped-env-secret-value-98765';
  const input = JSON.stringify({ error: `boom ${SECRET}`, note: `and ${odd}` });
  const r = runModule(['redact'], { ...GOOD, PROOF_STRIPE_SECRET_KEY: odd }, input);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('SecretMarker'));
  assert.ok(!r.stdout.includes(odd));
  assert.ok(secretValues({ ...GOOD }).length === 3);
});

test("a violation is the tenant's only when its document is the tenant's", () => {
  const v = (documentURI) => ({ directive: 'script-src-elem', blockedURI: 'x', documentURI });
  assert.equal(isTenantViolation(v('http://localhost:4321/'), ORIGIN), true);
  assert.equal(isTenantViolation(v('http://localhost:4321/#/portal/account/plans'), ORIGIN), true);
  assert.equal(
    isTenantViolation(v('https://checkout.stripe.com/c/pay/cs_test_abc'), ORIGIN),
    false
  );
  assert.equal(isTenantViolation(v('https://js.stripe.com/v3/m-outer.html'), ORIGIN), false);
  assert.equal(isTenantViolation(v(undefined), ORIGIN), true, 'unplaceable fails closed');
  assert.equal(isTenantViolation(v('about:srcdoc'), ORIGIN), true, 'unplaceable fails closed');
});

// The gate runner's own wiring of this module (the refusals before Docker, the keys
// by environment only, cleanup with -v) is tested in csp/gate/test_csp_checkout_gate.py.
