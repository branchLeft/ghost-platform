// node --test csp/proof/real-test-mode.test.mjs -- every refusal of the real
// Stripe TEST-mode switch, and the rule that no key value ever reaches output.
// No Docker, no browser, no network: the shell refuses before it starts either.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const GATE = fileURLToPath(new URL('../gate/csp-checkout-gate.sh', import.meta.url));
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
  assert.match(block, /^CSP_STRIPE_REAL_TEST_MODE=1 csp\/gate\/csp-checkout-gate\.sh$/m);
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

// The shell: real mode refuses before it starts Docker; the default path never
// mentions the switch. A shim docker records any call, so a refusal that
// reached Docker is seen.
function withShimDocker(run) {
  const dir = mkdtempSync(join(tmpdir(), 'csp real mode '));
  try {
    const marker = join(dir, 'docker-called');
    const shim = join(dir, 'docker');
    writeFileSync(shim, `#!/bin/sh\ntouch "${marker}"\nexit 97\n`);
    chmodSync(shim, 0o755);
    return run({ PATH: `${dir}:${process.env.PATH}` }, () => existsSync(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGate(args, env) {
  return spawnSync('sh', [GATE, ...args], { encoding: 'utf8', env });
}

test('shell: real mode with no keys refuses with exit 2, names each variable, never starts Docker', () => {
  withShimDocker((base, dockerCalled) => {
    const r = runGate([], { ...base, CSP_STRIPE_REAL_TEST_MODE: '1' });
    assert.equal(r.status, 2, r.stderr);
    for (const name of Object.keys(GOOD)) assert.match(r.stderr, new RegExp(name));
    assert.equal(dockerCalled(), false);
  });
});

test('shell: real mode with a live key refuses, prints no value, never starts Docker', () => {
  withShimDocker((base, dockerCalled) => {
    const r = runGate([], {
      ...base,
      ...GOOD,
      STRIPE_TEST_SECRET_KEY: LIVE_SECRET,
      CSP_STRIPE_REAL_TEST_MODE: '1',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /LIVE secret key is refused/);
    const seen = `${r.stdout}${r.stderr}`;
    for (const marker of MARKERS) assert.ok(!seen.includes(marker), marker);
    assert.equal(dockerCalled(), false);
  });
});

test('shell: real mode refuses another card number and a value of the switch that is not 1', () => {
  withShimDocker((base, dockerCalled) => {
    const card = runGate([], {
      ...base,
      ...GOOD,
      CSP_STRIPE_REAL_TEST_MODE: '1',
      CSP_STRIPE_TEST_CARD: '4000 0000 0000 0002',
    });
    assert.equal(card.status, 2, card.stderr);
    assert.match(card.stderr, /CSP_STRIPE_TEST_CARD/);
    const wrong = runGate([], { ...base, ...GOOD, CSP_STRIPE_REAL_TEST_MODE: 'yes' });
    assert.equal(wrong.status, 2, wrong.stderr);
    assert.match(wrong.stderr, /CSP_STRIPE_REAL_TEST_MODE must be 1/);
    assert.equal(dockerCalled(), false);
  });
});

test('shell: real mode refuses a tenant port setting that points the origin off this machine', () => {
  withShimDocker((base, dockerCalled) => {
    const r = runGate([], {
      ...base,
      ...GOOD,
      CSP_STRIPE_REAL_TEST_MODE: '1',
      CSP_CHECKOUT_PORT: '4321@tenant.example.com',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /local disposable tenant/);
    assert.equal(dockerCalled(), false);
  });
});

test('shell: real mode refuses --derive, which needs no keys and measures the real Stripe.js', () => {
  withShimDocker((base, dockerCalled) => {
    const r = runGate(['--derive'], {
      ...base,
      ...GOOD,
      CSP_STRIPE_REAL_TEST_MODE: '1',
      CSP_STRIPE_REAL_JS: '1',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--derive/);
    assert.equal(dockerCalled(), false);
  });
});

test('shell: --help prints the owner command and exits 0 without Docker', () => {
  withShimDocker((base, dockerCalled) => {
    const r = runGate(['--help'], base);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(ownerCommand()));
    assert.match(
      r.stdout,
      /stripe listen --forward-to http:\/\/localhost:4321\/members\/webhooks\/stripe\//
    );
    assert.equal(dockerCalled(), false);
  });
});

// The wiring past the refusals, with no Docker: the gate's own scripts are
// copied into a temp tree with shim docker and curl (both succeed and record
// their arguments) and a stub for the one script that receives the keys. The
// run dies at the first script the tree lacks, after Ghost would have started.
function withGateTree(run) {
  const root = mkdtempSync(join(tmpdir(), 'csp gate tree '));
  try {
    const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
    for (const [from, to] of [
      ['../gate/csp-checkout-gate.sh', 'csp/gate/csp-checkout-gate.sh'],
      ['../gate/lib.sh', 'csp/gate/lib.sh'],
      ['./real-test-mode.mjs', 'csp/proof/real-test-mode.mjs'],
    ]) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      copyFileSync(here(from), join(root, to));
    }
    mkdirSync(join(root, 'render-core/dist'), { recursive: true });
    writeFileSync(join(root, 'render-core/dist/index.js'), '');
    const trace = join(root, 'setup-paid-saw.json');
    writeFileSync(
      join(root, 'csp/proof/setup-paid.mjs'),
      `import { writeFileSync } from 'node:fs';\n` +
        `const e = process.env;\n` +
        `writeFileSync(${JSON.stringify(trace)}, JSON.stringify({\n` +
        `  secret: e.PROOF_STRIPE_SECRET_KEY === e.STRIPE_TEST_SECRET_KEY,\n` +
        `  publishable: e.PROOF_STRIPE_PUBLISHABLE_KEY === e.STRIPE_TEST_PUBLISHABLE_KEY,\n` +
        `  flag: e.PROOF_REAL_TEST_MODE ?? null,\n}));\n`
    );
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'docker-argv.log');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'docker'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);
    const exec = (args, env) =>
      spawnSync('sh', [...args, join(root, 'csp/gate/csp-checkout-gate.sh')], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      });
    const dockerLines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []);
    const sawSetupPaid = () => (existsSync(trace) ? JSON.parse(readFileSync(trace, 'utf8')) : null);
    return run({ exec, dockerLines, sawSetupPaid });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REAL_ENV = { ...GOOD, CSP_STRIPE_REAL_TEST_MODE: '1' };

test('shell wiring, real mode: Ghost is started with no fake and no key in any docker argument', () => {
  withGateTree(({ exec, dockerLines }) => {
    const r = exec([], REAL_ENV);
    const lines = dockerLines();
    const ghost = lines.find((l) => l.includes('stripeDirect=true'));
    assert.ok(ghost, `Ghost was never started: ${r.stderr}`);
    assert.match(ghost, / -e WEBHOOK_SECRET /, 'the webhook secret is passed by name');
    assert.doesNotMatch(ghost, /STRIPE_API_HOST|STRIPE_API_PORT|STRIPE_API_PROTOCOL/);
    assert.ok(!lines.some((l) => l.includes('fake-stripe.mjs')), 'no fake Stripe is started');
    for (const marker of MARKERS) {
      assert.ok(!lines.join('\n').includes(marker), `${marker} reached a docker argument`);
      assert.ok(!`${r.stdout}${r.stderr}`.includes(marker), `${marker} reached the output`);
    }
  });
});

test("shell wiring, real mode: the owner's keys reach the setup script by environment, with the switch on", () => {
  withGateTree(({ exec, sawSetupPaid }) => {
    exec([], REAL_ENV);
    assert.deepEqual(sawSetupPaid(), { secret: true, publishable: true, flag: '1' });
  });
});

test('shell wiring, real mode: tracing the shell (sh -x) never shows a key', () => {
  withGateTree(({ exec, sawSetupPaid }) => {
    const r = exec(['-x'], REAL_ENV);
    assert.ok(sawSetupPaid(), `the run never got as far as the keys: ${r.stderr.slice(-300)}`);
    for (const marker of MARKERS) assert.ok(!r.stderr.includes(marker), `${marker} was traced`);
  });
});

test("shell wiring, default: the fake Stripe starts as before and the owner's variables are not read", () => {
  withGateTree(({ exec, dockerLines, sawSetupPaid }) => {
    exec([], { ...GOOD });
    const lines = dockerLines();
    assert.ok(
      lines.some((l) => l.includes('fake-stripe.mjs')),
      'the fake starts'
    );
    const ghost = lines.find((l) => l.includes('stripeDirect=true'));
    assert.match(
      ghost,
      /-e STRIPE_API_HOST=csp-checkout-stripe-\d+ -e STRIPE_API_PORT=12111 -e STRIPE_API_PROTOCOL=http -e WEBHOOK_SECRET=whsec_/
    );
    for (const marker of MARKERS) assert.ok(!lines.join('\n').includes(marker), marker);
    assert.deepEqual(sawSetupPaid(), { secret: false, publishable: false, flag: null });
  });
});

test('shell: without the switch the real-mode code is never reached, even with test keys in the environment', () => {
  withShimDocker((base) => {
    const r = runGate([], { ...base, ...GOOD, STRIPE_TEST_SECRET_KEY: LIVE_SECRET });
    assert.notEqual(r.status, 0);
    const seen = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(seen, /REAL TEST MODE|STRIPE_TEST_|real test mode/);
    for (const marker of MARKERS) assert.ok(!seen.includes(marker), marker);
  });
});
