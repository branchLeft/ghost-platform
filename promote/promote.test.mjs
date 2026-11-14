// The promotion predicate, its shared check, the verify step and the fetch
// helper. Records are built from the real fixture trees of the classifier (a
// real reversible step, a real forward-only step), and gate reports from the
// gate set's own runner, so nothing here is hand-shaped to pass. Mutated copies
// make the lying and malformed cases. No Docker and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPORT_SCHEMA, REQUIRED_GATES } from '../gate-set/gate-set.mjs';
import { readMigrations } from '../services/release-classifier/src/cli.mjs';
import { classifySteps } from '../services/release-classifier/src/steps.mjs';
import { buildPredicate, main as buildMain } from './build-predicate.mjs';
import { main as checkMain } from './check-predicate.mjs';
import { fetchMigrations, main as fetchMain } from './fetch-ghost-migrations.mjs';
import { PREDICATE_TYPE, ROUTE, checkPredicate } from './shape.mjs';
import {
  main as verifyMain,
  readVerified,
  verifyPromotion,
  verifyWithRetry,
} from './verify-promotion.mjs';

const FIXTURES = path.join(
  import.meta.dirname,
  '..',
  'services',
  'release-classifier',
  'test',
  'fixtures'
);
const load = (dir) => readMigrations(path.join(FIXTURES, dir));
const fast = load('fast-path');
const versions = load('versions');
const extra = load('steps');
const inFolder = (list, folder) => list.filter((m) => m.folder === folder);

const t656 = [...inFolder(extra, '6.56'), ...inFolder(fast, '6.56')];
const t657 = [...t656, ...inFolder(versions, '6.57')];
const t665 = inFolder(fast, '6.65');
const t666 = [...t665, ...inFolder(fast, '6.66')];

const reversible = classifySteps({
  releases: [
    { tag: 'v6.65.0', migrations: t665 },
    { tag: 'v6.66.0', migrations: t666 },
  ],
});
const forwardOnly = classifySteps({
  releases: [
    { tag: 'v6.56.0', migrations: t656 },
    { tag: 'v6.57.0', migrations: t657 },
  ],
});

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const POLICY = 'c'.repeat(64);
const COMMITS = { fromCommit: 'd'.repeat(40), toCommit: 'e'.repeat(40) };
const clone = (x) => JSON.parse(JSON.stringify(x));

const greenReport = (digest = DIGEST) => ({
  schema: REPORT_SCHEMA,
  digest,
  image: 'ghcr.io/branchleft/ghost-tenant',
  ok: true,
  results: REQUIRED_GATES.map((name) => ({ name, ok: true, durationMs: 1, detail: 'log text' })),
});

const base = {
  digest: DIGEST,
  version: 'v6.66.0',
  fromVersion: 'v6.65.0',
  policySha256: POLICY,
  record: reversible,
  gateReport: greenReport(),
  ...COMMITS,
};
const expected = { digest: DIGEST, version: 'v6.66.0', fromVersion: 'v6.65.0' };

test('a reversible step with a green gate record for this digest is fast-path', () => {
  const p = buildPredicate(base);
  assert.equal(p.route, ROUTE.FAST_PATH);
  assert.deepEqual(p.refusals, []);
  assert.equal(p.digest, DIGEST);
  assert.equal(p.version, 'v6.66.0');
  assert.equal(p.fromVersion, 'v6.65.0');
  assert.equal(p.policySha256, POLICY);
  assert.deepEqual(
    p.gates.results.map((r) => r.name),
    REQUIRED_GATES
  );
  assert.ok(p.gates.results.every((r) => r.ok === true));
  assert.deepEqual(checkPredicate(p, expected), { ok: true });
});

test('the predicate carries each gate by name and result only, never a gate log', () => {
  const text = JSON.stringify(buildPredicate(base));
  assert.doesNotMatch(text, /log text/);
});

test('a real forward-only step routes to consent and names the refusal', () => {
  const p = buildPredicate({
    ...base,
    version: 'v6.57.0',
    fromVersion: 'v6.56.0',
    record: forwardOnly,
  });
  assert.equal(p.route, ROUTE.CONSENT);
  assert.equal(p.classification.ok, false);
  assert.equal(p.refusals[0].source, 'classification');
  assert.equal(p.refusals[0].reason, 'forward-only');
  assert.deepEqual(
    checkPredicate(p, { digest: DIGEST, version: 'v6.57.0', fromVersion: 'v6.56.0' }),
    { ok: true },
    'a consent predicate is a well-formed hold'
  );
});

test('a record for another release, an unreadable record and a lying record are consent', () => {
  const lying = clone(forwardOnly);
  lying.class = 'reversible';
  lying.steps[0].class = 'reversible';
  const cases = {
    'another release': { ...base, version: 'v6.67.0' },
    'no record': { ...base, record: null },
    'garbage record': { ...base, record: { schema: 'nope' } },
    'lying record': { ...base, version: 'v6.57.0', fromVersion: 'v6.56.0', record: lying },
  };
  for (const [name, input] of Object.entries(cases)) {
    const p = buildPredicate(input);
    assert.equal(p.route, ROUTE.CONSENT, name);
    assert.equal(p.classification.ok, false, name);
  }
});

test('a red, missing, repeated, foreign or malformed gate record is consent', () => {
  const red = greenReport();
  red.results[2].ok = false;
  const missing = greenReport();
  missing.results.pop();
  const repeated = greenReport();
  repeated.results.push({ ...repeated.results[0] });
  const lyingSummary = greenReport();
  lyingSummary.results[0].ok = false;
  lyingSummary.ok = true;
  const cases = {
    red,
    missing,
    repeated,
    'another digest': greenReport(OTHER),
    'summary that lies': lyingSummary,
    none: null,
    'not a report': { results: [] },
  };
  for (const [name, gateReport] of Object.entries(cases)) {
    const p = buildPredicate({ ...base, gateReport });
    assert.equal(p.route, ROUTE.CONSENT, name);
    assert.equal(p.gates.ok, false, name);
    assert.ok(
      p.refusals.some((r) => r.source === 'gates'),
      name
    );
  }
});

test('input that cannot be recorded throws and no predicate exists', () => {
  for (const bad of [
    { digest: 'sha256:abc' },
    { digest: 'ghost@sha256:' + 'a'.repeat(64) },
    { version: '6.66.0' },
    { fromVersion: 'latest' },
    { version: 'v6.65.0' },
    { policySha256: 'xyz' },
    { policySha256: undefined },
    { fromCommit: 'main' },
    { toCommit: '' },
  ]) {
    assert.throws(() => buildPredicate({ ...base, ...bad }), RangeError, JSON.stringify(bad));
  }
});

test('the shared check refuses a predicate for another digest or release or a lying route', () => {
  const p = buildPredicate(base);
  const refused = (mutate, reason) => {
    const q = clone(p);
    mutate(q);
    const verdict = checkPredicate(q, expected);
    assert.equal(verdict.ok, false, reason);
    assert.equal(verdict.reason, reason);
  };
  refused((q) => (q.digest = OTHER), 'digest-mismatch');
  refused((q) => (q.version = 'v6.67.0'), 'release-mismatch');
  refused((q) => (q.fromVersion = 'v6.64.0'), 'release-mismatch');
  refused((q) => (q.schema = 'promotion/v0'), 'predicate-malformed');
  refused((q) => (q.policySha256 = ''), 'policy-hash-missing');
  refused((q) => (q.route = 'auto'), 'route-unknown');
  refused((q) => (q.refusals = [{ source: 'gates' }]), 'route-contradicted');
  refused((q) => (q.classification.ok = false), 'route-contradicted');
  refused((q) => (q.gates.ok = false), 'route-contradicted');
  refused((q) => q.gates.results.pop(), 'route-contradicted');
  refused((q) => (q.gates.results[1].ok = false), 'route-contradicted');
  refused((q) => q.gates.results.push({ name: 'extra', ok: false }), 'route-contradicted');
  assert.equal(checkPredicate(null, expected).ok, false);
  assert.equal(checkPredicate(p, { ...expected, digest: 'x' }).reason, 'expected-malformed');
});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
}

function files(dir, { steps = reversible, report = greenReport(), policy = 'policy v1\n' } = {}) {
  const out = {
    steps: path.join(dir, 'steps.json'),
    report: path.join(dir, 'gate-report.json'),
    policy: path.join(dir, 'policy.json'),
    out: path.join(dir, 'predicate.json'),
  };
  if (steps !== null) fs.writeFileSync(out.steps, JSON.stringify(steps));
  if (report !== null) fs.writeFileSync(out.report, JSON.stringify(report));
  if (policy !== null) fs.writeFileSync(out.policy, policy);
  return out;
}

const argv = (f, over = {}) => {
  const flags = {
    digest: DIGEST,
    version: 'v6.66.0',
    'from-version': 'v6.65.0',
    'policy-file': f.policy,
    steps: f.steps,
    'gate-report': f.report,
    'from-commit': COMMITS.fromCommit,
    'to-commit': COMMITS.toCommit,
    out: f.out,
    ...over,
  };
  return Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]);
};

test('the CLI hashes the policy file bytes, writes the predicate and exits 0', () => {
  const dir = tmp();
  try {
    const f = files(dir);
    const lines = [];
    assert.equal(
      buildMain(argv(f), (l) => lines.push(l)),
      0
    );
    const p = JSON.parse(fs.readFileSync(f.out, 'utf8'));
    assert.equal(p.route, ROUTE.FAST_PATH);
    assert.equal(p.policySha256, createHash('sha256').update('policy v1\n').digest('hex'));
    assert.match(lines[0], /^ROUTE fast-path digest=sha256:a{64}$/);

    fs.writeFileSync(f.policy, 'policy v2\n');
    assert.equal(
      buildMain(argv(f), () => {}),
      0
    );
    const q = JSON.parse(fs.readFileSync(f.out, 'utf8'));
    assert.notEqual(q.policySha256, p.policySha256, 'a changed policy changes the hash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI writes a consent predicate when a record is missing or unparsable', () => {
  const dir = tmp();
  try {
    const f = files(dir, { steps: null });
    fs.writeFileSync(f.report, '{not json');
    assert.equal(
      buildMain(argv(f), () => {}),
      0
    );
    const p = JSON.parse(fs.readFileSync(f.out, 'utf8'));
    assert.equal(p.route, ROUTE.CONSENT);
    assert.equal(p.refusals.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 and writes nothing when the policy file or a flag is unusable', () => {
  const dir = tmp();
  try {
    const f = files(dir, { policy: null });
    assert.equal(
      buildMain(argv(f), () => {}),
      1,
      'no policy file'
    );
    assert.equal(fs.existsSync(f.out), false);
    const g = files(dir);
    assert.equal(
      buildMain(argv(g, { digest: 'latest' }), () => {}),
      1
    );
    assert.equal(
      buildMain(argv(g).slice(0, -2), () => {}),
      1,
      'a missing flag'
    );
    assert.equal(fs.existsSync(g.out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the signing job check: 0 accepted, 2 refused, 1 usage, never 0 on a bad file', () => {
  const dir = tmp();
  try {
    const f = files(dir);
    buildMain(argv(f), () => {});
    const flags = ['--digest', DIGEST, '--version', 'v6.66.0', '--from-version', 'v6.65.0'];
    assert.equal(
      checkMain(['--predicate', f.out, ...flags], () => {}),
      0
    );
    assert.equal(
      checkMain(['--predicate', f.out, ...flags.map((x) => (x === DIGEST ? OTHER : x))], () => {}),
      2
    );
    assert.equal(
      checkMain(['--predicate', path.join(dir, 'absent.json'), ...flags], () => {}),
      2
    );
    fs.writeFileSync(f.out, '[]');
    assert.equal(
      checkMain(['--predicate', f.out, ...flags], () => {}),
      2
    );
    assert.equal(
      checkMain(['--predicate', f.out], () => {}),
      1
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the verify step ----

const IMAGE = `ghcr.io/branchleft/ghost-tenant@${DIGEST}`;
const REPO = 'branchLeft/ghost-platform';
const SIGNER = `${REPO}/.github/workflows/promote-candidate.yml`;
const ask = {
  image: IMAGE,
  repo: REPO,
  signerWorkflow: SIGNER,
  version: 'v6.66.0',
  fromVersion: 'v6.65.0',
};

const statement = (predicate, over = {}) => ({
  verificationResult: {
    statement: {
      predicateType: PREDICATE_TYPE,
      subject: [{ name: 'ghcr.io/branchleft/ghost-tenant', digest: { sha256: 'a'.repeat(64) } }],
      predicate,
      ...over,
    },
  },
});

// A gh that verifies the right signer and refuses any other for its identity.
function fakeGh(
  predicate,
  { rows, wrongStatus = 1, wrongText = 'no matching CertificateIdentity found' } = {}
) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const signer = args[args.indexOf('--signer-workflow') + 1];
    if (signer.endsWith('.sabotage')) return { status: wrongStatus, stdout: '', stderr: wrongText };
    return { status: 0, stdout: JSON.stringify(rows ?? [statement(predicate)]), stderr: '' };
  };
  return { run, calls };
}

test('verify: both reads and the control pass for a good attestation', () => {
  const p = buildPredicate(base);
  const { run, calls } = fakeGh(p);
  const verdict = verifyPromotion(ask, run);
  assert.equal(verdict.ok, true);
  assert.equal(calls.length, 4, 'two reads then the control through both reads');
  assert.deepEqual(
    calls.map((a) => a.includes('--bundle-from-oci')),
    [false, true, false, true]
  );
  for (const args of calls) {
    for (const [flag, value] of [
      ['--source-ref', 'refs/heads/main'],
      ['--cert-oidc-issuer', 'https://token.actions.githubusercontent.com'],
      ['--predicate-type', PREDICATE_TYPE],
      ['--repo', REPO],
    ]) {
      assert.equal(args[args.indexOf(flag) + 1], value);
    }
    assert.ok(args.includes('--deny-self-hosted-runners'));
    assert.equal(args[2], `oci://${IMAGE}`);
  }
});

test('verify: a tag, a foreign signer or a malformed repo is refused before gh runs', () => {
  const never = () => assert.fail('gh must not run');
  assert.equal(
    verifyPromotion({ ...ask, image: 'ghcr.io/branchleft/ghost-tenant:latest' }, never).ok,
    false
  );
  assert.equal(
    verifyPromotion({ ...ask, signerWorkflow: 'other/repo/.github/workflows/x.yml' }, never).ok,
    false
  );
  assert.equal(verifyPromotion({ ...ask, repo: 'nope' }, never).ok, false);
});

test('verify: a failed read, other-digest subject, other-release predicate or wrong type is refused', () => {
  const p = buildPredicate(base);
  const failing = (args) => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.equal(verifyPromotion(ask, failing).reason, 'api-verify-failed');
  const registryOnly = (args) =>
    args.includes('--bundle-from-oci')
      ? { status: 1, stdout: '', stderr: 'down' }
      : fakeGh(p).run(args);
  assert.equal(verifyPromotion(ask, registryOnly).reason, 'registry-verify-failed');

  const wrongSubject = [statement(p, { subject: [{ digest: { sha256: 'b'.repeat(64) } }] })];
  assert.equal(
    verifyPromotion(ask, fakeGh(p, { rows: wrongSubject }).run).reason,
    'subject-mismatch'
  );
  const otherRelease = buildPredicate({ ...base, version: 'v6.67.0' });
  assert.equal(verifyPromotion(ask, fakeGh(otherRelease).run).reason, 'release-mismatch');
  const wrongType = [statement(p, { predicateType: 'https://slsa.dev/provenance/v1' })];
  assert.equal(
    verifyPromotion(ask, fakeGh(p, { rows: wrongType }).run).reason,
    'no-verified-statement'
  );
  assert.equal(readVerified('not json', expected).reason, 'verify-output-unreadable');
  assert.equal(readVerified('[]', expected).reason, 'no-verified-statement');
});

test('verify: a control that is accepted, or refused for a fault, fails the check', () => {
  const p = buildPredicate(base);
  assert.equal(verifyPromotion(ask, fakeGh(p, { wrongStatus: 0 }).run).reason, 'control-accepted');
  assert.equal(
    verifyPromotion(ask, fakeGh(p, { wrongText: 'dial tcp: i/o timeout' }).run).reason,
    'control-failed-for-another-reason'
  );
});

test('verify CLI: 0 verified, 2 refused, 1 usage', () => {
  const p = buildPredicate(base);
  const flags = [
    '--image',
    IMAGE,
    '--repo',
    REPO,
    '--signer-workflow',
    SIGNER,
    '--version',
    'v6.66.0',
    '--from-version',
    'v6.65.0',
  ];
  const lines = [];
  assert.equal(
    verifyMain(flags, (l) => lines.push(l), fakeGh(p).run),
    0
  );
  assert.match(lines[0], /^VERIFIED .* route=fast-path$/);
  const waits = [];
  assert.equal(
    verifyMain(
      flags,
      () => {},
      () => ({ status: 1, stdout: '', stderr: '' }),
      (s) => waits.push(s)
    ),
    2
  );
  assert.deepEqual(waits, [12, 24, 36, 48], 'five attempts, waiting between them');
  assert.equal(
    verifyMain(flags.slice(2), () => {}, fakeGh(p).run),
    1
  );
});

test('verify: a late attestation is retried, a wrong release and a control failure are not', () => {
  const p = buildPredicate(base);
  const good = fakeGh(p).run;
  let reads = 0;
  const late = (args) => {
    if (!args[args.indexOf('--signer-workflow') + 1].endsWith('.sabotage') && reads++ < 2) {
      return { status: 1, stdout: '', stderr: 'no attestations found' };
    }
    return good(args);
  };
  const waits = [];
  assert.equal(verifyWithRetry(ask, late, (s) => waits.push(s)).ok, true);
  assert.deepEqual(waits, [12, 24]);

  let calls = 0;
  const wrongRelease = fakeGh(buildPredicate({ ...base, version: 'v6.67.0' })).run;
  const counted = (args) => (calls++, wrongRelease(args));
  assert.equal(
    verifyWithRetry(ask, counted, () => assert.fail('no wait')).reason,
    'release-mismatch'
  );
  assert.equal(calls, 1);

  const accepted = fakeGh(p, { wrongStatus: 0 }).run;
  assert.equal(
    verifyWithRetry(ask, accepted, () => assert.fail('no wait')).reason,
    'control-accepted'
  );
});

// ---- the fetch helper ----

test('fetch: refuses anything but a plain tag and an absent destination, runs only git argv', () => {
  const dir = tmp();
  try {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return `${'f'.repeat(40)}\n`;
      if (args[0] === 'checkout') {
        fs.mkdirSync(path.join(dest, 'ghost/core/core/server/data/migrations/versions'), {
          recursive: true,
        });
      }
      return '';
    };
    const dest = path.join(dir, 'tree');
    assert.equal(fetchMigrations({ tag: 'v6.66.0', dest }, git), 'f'.repeat(40));
    assert.deepEqual(calls[0], ['init', '--quiet']);
    assert.ok(calls.some((a) => a.includes('refs/tags/v6.66.0')));
    assert.ok(calls.some((a) => a[0] === 'sparse-checkout'));
    assert.throws(() => fetchMigrations({ tag: 'v6.66.0', dest }, git), /exists/);
    for (const tag of [
      'main',
      'v6.66',
      '6.66.0',
      'v6.66.0; rm -rf /',
      '--upload-pack=x',
      undefined,
    ]) {
      assert.throws(() => fetchMigrations({ tag, dest: path.join(dir, 'x') }, git), RangeError);
    }
    assert.equal(
      fetchMain(['--tag', 'main', '--dest', path.join(dir, 'y')], () => {}, git),
      1
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
