// The broker release workflow signs and publishes code that later runs as a
// root-adjacent service, so a mistake in it is silent: a release that
// verifies as genuine and is not. These checks pin the properties that keep
// it safe -- the tag prefix that keeps it apart from the other two release
// workflows, the split of privileges between the job that runs dependency
// code and the job that signs, the order of the tag check, the attestation
// and the release, what exactly is attested, and that every action is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');

function uncommented(file) {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf-8').replace(/^[ \t]*#.*$/gm, '');
}

function tagPatterns(text) {
  const block = text.match(/tags:\n((?:[ \t]+- .*\n)+)/);
  assert.ok(block, 'workflow has a tags trigger');
  return [...block[1].matchAll(/- '([^']+)'/g)].map((m) => m[1]);
}

// GitHub's tag filter is a glob over the whole ref name; the only operator
// used in these workflows is a `[0-9]+` run. Everything between runs is
// escaped as a literal, then the runs become a regex.
function globToRegex(glob) {
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${glob.split('[0-9]+').map(literal).join('[0-9]+')}$`);
}

// The text of one job: from its `  name:` line to the next job or the end.
function jobBlock(text, name) {
  const start = text.search(new RegExp(`^  ${name}:\\n`, 'm'));
  assert.ok(start > -1, `workflow has a ${name} job`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

const release = uncommented('broker-release.yml');
const renderCore = uncommented('publish-render-core.yml');
const tenant = uncommented('publish-tenant-package.yml');
const beforeJobs = release.slice(0, release.indexOf('\njobs:'));
const build = jobBlock(release, 'build');
const publish = jobBlock(release, 'release');

test('triggers on a broker release tag and on pull requests, never on dispatch', () => {
  assert.deepEqual(tagPatterns(release), ['broker-v[0-9]+.[0-9]+.[0-9]+']);
  assert.match(release, /^ {2}pull_request:/m);
  assert.doesNotMatch(release, /workflow_dispatch/, 'a dispatch could sign an arbitrary ref');
});

test("none of the three release tag patterns matches another's tags", () => {
  const broker = globToRegex(tagPatterns(release)[0]);
  const render = globToRegex(tagPatterns(renderCore)[0]);
  const tenantRe = globToRegex(tagPatterns(tenant)[0]);
  assert.ok(broker.test('broker-v1.2.3'));
  assert.ok(render.test('render-core-v1.2.3'));
  assert.ok(tenantRe.test('v1.2.3'));
  for (const tag of ['v1.2.3', 'render-core-v1.2.3', 'xbroker-v1.2.3', 'broker-v1.2']) {
    assert.ok(!broker.test(tag), `${tag} must not start the broker release`);
  }
  assert.ok(!render.test('broker-v1.2.3'), 'a broker tag must not start the render-core release');
  assert.ok(!tenantRe.test('broker-v1.2.3'), 'a broker tag must not start the tenant release');
});

test('top-level permissions are read-only', () => {
  assert.match(beforeJobs, /permissions:\n {2}contents: read\n {2}packages: read\n/);
  assert.doesNotMatch(beforeJobs, /write|id-token|attestations/);
});

test('the write and signing permissions appear only in the release job', () => {
  for (const grant of ['id-token: write', 'attestations: write', 'contents: write']) {
    assert.equal(release.split(grant).length - 1, 1, `${grant} appears exactly once`);
    assert.ok(publish.includes(grant), `${grant} is in the release job`);
    assert.ok(!build.includes(grant), `${grant} is not in the build job`);
  }
  assert.ok(!/permissions:/.test(build), 'the build job takes only the read-only top level');
  assert.match(publish, /if: github\.ref_type == 'tag'/);
  assert.match(publish, /needs: build/);
});

test('the only secret referenced is the run token', () => {
  const secrets = [...release.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((name) => name === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
});

test('the release job runs no install or build step', () => {
  assert.doesNotMatch(
    publish,
    /pnpm|npm |npx|yarn|setup-node|action-setup|working-directory: (services|render-core)/
  );
  // And the build job is where dependency code runs.
  assert.match(build, /pnpm install --frozen-lockfile/);
  assert.match(build, /pnpm run bundle/);
});

test('the tag is checked before it is attested, and attested before it is released', () => {
  const check = publish.indexOf('check_release_tag.py');
  const digest = publish.indexOf('sha256sum --check');
  const attest = publish.indexOf('actions/attest-build-provenance@');
  const create = publish.indexOf('gh release create');
  assert.ok(check > -1 && digest > -1 && attest > -1 && create > -1);
  assert.ok(check < attest, 'the tag check runs before the attestation');
  assert.ok(digest < attest, 'the digest check runs before the attestation');
  assert.ok(attest < create, 'the attestation runs before the release is created');
});

test('the tag check is given everything it refuses on', () => {
  for (const flag of [
    '--tag',
    '--ref-json',
    '--tag-json',
    '--package-json',
    '--expect-sha "${GITHUB_SHA}"',
    '--repo-dir',
  ]) {
    assert.ok(publish.includes(flag), `check_release_tag.py is given ${flag}`);
  }
});

test('the attested subject is exactly the tarball', () => {
  const subjects = [...publish.matchAll(/subject-[a-z]+: (.*)/g)];
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0][0].split(':')[0], 'subject-path');
  assert.equal(
    subjects[0][1].trim(),
    'broker-release/broker-bundle-${{ needs.build.outputs.version }}.tar.gz'
  );
  assert.doesNotMatch(subjects[0][1], /\*/, 'no glob in the subject');
});

test('the release carries the tarball, its digest and its attestation, and never replaces one', () => {
  for (const asset of [
    'broker-bundle-${BUILD_VERSION}.tar.gz"',
    'broker-bundle-${BUILD_VERSION}.tar.gz.sha256"',
    'broker-bundle-${BUILD_VERSION}.tar.gz.sigstore.json"',
  ]) {
    assert.ok(publish.includes(asset), `release asset ${asset}`);
  }
  assert.doesNotMatch(publish, /gh release (edit|upload|delete)|--clobber/);
});

test('every action is pinned to a full commit sha with a version comment', () => {
  const uses = [...release.matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 6);
  for (const line of uses) {
    assert.match(line, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `pinned: ${line}`);
  }
  assert.ok(uses.some((line) => line.startsWith('actions/attest-build-provenance@')));
});

test('every job sets a timeout', () => {
  for (const job of [build, publish]) {
    assert.match(job, /timeout-minutes: \d+/);
  }
});

// --- the pnpm cache is off on a tag run -------------------------------------

// In an Actions expression '' is falsy, so `ref_type == 'tag' && '' || 'pnpm'`
// is 'pnpm' on a tag too. This small evaluator follows the documented rules:
// `&&` and `||` return an operand, not a boolean, and '' / 0 / false / null are
// falsy. It handles only what the cache line uses: ==, !=, string literals and
// the one context value.
function evaluateExpression(expression, context) {
  const falsy = (value) => value === '' || value === false || value === 0 || value === null;
  const atom = (text) => {
    const t = text.trim();
    const compare = t.match(/^github\.ref_type\s*(==|!=)\s*'([^']*)'$/);
    if (compare) {
      return compare[1] === '=='
        ? context.ref_type === compare[2]
        : context.ref_type !== compare[2];
    }
    const literal = t.match(/^'([^']*)'$/);
    assert.ok(literal, `unsupported expression term: ${t}`);
    return literal[1];
  };
  const andChain = (text) => {
    const operands = text.split('&&').map(atom);
    return operands.find(falsy) ?? operands[operands.length - 1];
  };
  const operands = expression.split('||').map(andChain);
  return operands.find((value) => !falsy(value)) ?? operands[operands.length - 1];
}

test('the build job gives a tag run no pnpm cache and every other run the cache', () => {
  const lines = build.split('\n').filter((line) => /^\s*cache:/.test(line));
  assert.equal(lines.length, 1, 'one cache line in the build job');
  assert.equal(
    lines[0].trim(),
    "cache: ${{ github.ref_type != 'tag' && 'pnpm' || '' }}",
    'the exact form: the cache name sits right of the && and an empty string right of the ||'
  );
  assert.doesNotMatch(
    build,
    /ref_type == 'tag' && '' \|\| 'pnpm'/,
    'the inverted form gives a tag run the cache'
  );
  assert.doesNotMatch(build, /cache: pnpm/, 'no unconditional cache');

  const expression = lines[0].match(/\$\{\{\s*(.*?)\s*\}\}/)[1];
  assert.equal(
    evaluateExpression(expression, { ref_type: 'tag' }),
    '',
    'a tag run: empty, so no cache'
  );
  assert.equal(
    evaluateExpression(expression, { ref_type: 'branch' }),
    'pnpm',
    'a branch run keeps the cache'
  );

  // The evaluator must tell the two forms apart, or the checks above prove nothing.
  const inverted = "github.ref_type == 'tag' && '' || 'pnpm'";
  assert.equal(
    evaluateExpression(inverted, { ref_type: 'tag' }),
    'pnpm',
    'the inverted form caches on a tag'
  );
});

// --- the runbook section is the contract the consumer follows ---------------

const RUNBOOK_FILE = path.join(
  import.meta.dirname,
  'services',
  'broker',
  'RUNBOOK-broker-deploy.md'
);
const runbook = fs.readFileSync(RUNBOOK_FILE, 'utf-8');

function runbookSection(title) {
  const start = runbook.indexOf(`\n## ${title}\n`);
  assert.ok(start > -1, `runbook has the section "${title}"`);
  const rest = runbook.slice(start + 1);
  const next = rest.slice(3).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

const section = runbookSection('Release artifact and how to verify it');

function bashBlocks(text) {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function ancestorBlock() {
  const blocks = bashBlocks(section).filter((block) => block.includes('/compare/'));
  assert.equal(blocks.length, 1, 'exactly one fenced block runs the ancestor check');
  return blocks[0];
}

// The first fenced block: the attestation verify and the digest check.
function verifyBlock() {
  const blocks = bashBlocks(section).filter((block) => block.includes('gh attestation verify'));
  assert.equal(blocks.length, 1, 'exactly one fenced block runs the attestation verify');
  return blocks[0];
}

// `refs/heads/main` names the branch. A bare `main` is resolved by GitHub as a
// tag first, and a tag named `main` is pushable (the `release tags` ruleset
// covers only `v[0-9]*.[0-9]*.[0-9]*`), so the bare form could be answered
// about the wrong ref.
const COMPARE_URL =
  'https://api.github.com/repos/branchLeft/ghost-platform/compare/refs/heads/main...';
const SHA_GUARD = '[[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]';

test('the runbook states the published-release rule without history', () => {
  assert.ok(
    runbook.includes('A published release is never replaced; a fix ships as a new version.'),
    'the rule, verbatim'
  );
  assert.doesNotMatch(
    runbook,
    /supersed/i,
    'no superseded-decision wording anywhere in the runbook'
  );
});

test('the runbook does not claim the tag check proves what it cannot', () => {
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /runs from the tagged commit's own copy/);
  assert.match(flat, /guard against mistakes, not a control/);
  assert.match(flat, /sha256 pinned in reviewed shared-infra code/);
  assert.match(flat, /consumer's check below that the attested commit is on `main`/);
});

test('the ancestor check passes behind or identical and nothing else, and fails the deploy', () => {
  const block = ancestorBlock();
  assert.ok(
    block.includes(`"${COMPARE_URL}\${SOURCE_COMMIT}"`),
    'the anonymous compare URL, exactly'
  );
  assert.doesNotMatch(block, /GH_TOKEN|Authorization|--header|-H /, 'anonymous: no token');
  assert.ok(
    block.includes(SHA_GUARD),
    'the whole-string 40-hex guard before the commit goes into a URL'
  );
  assert.doesNotMatch(block, /grep -Eq/, 'a line-matching grep is not the guard');

  const passing = block.match(/case "\$\{STATUS\}" in\n\s*([^)\n]+)\) ;;/);
  assert.ok(passing, 'the first case arm is the passing one and does nothing');
  assert.deepEqual(
    passing[1].split('|').map((word) => word.trim()),
    ['behind', 'identical'],
    'exactly behind or identical passes'
  );
  assert.match(block, /\n\s*\*\)\n/, 'every other answer reaches the catch-all arm');
  for (const word of ['ahead', 'diverged']) {
    assert.ok(!block.includes(word), `${word} is not named in the check, so it cannot pass`);
  }
  assert.equal(block.split('exit 1').length - 1, 2, 'the bad sha and the bad status each exit 1');
});

test('no ancestor check anywhere in the runbook asks about a bare main', () => {
  assert.doesNotMatch(runbook, /compare\/main\.\.\./, 'a bare main can resolve to a tag');
  assert.ok(runbook.includes(`${COMPARE_URL}\${SOURCE_COMMIT}`), 'the refs/heads/main form');
});

test('the runbook names the four unobserved items and the ruleset gap', () => {
  const paragraph = section.match(/\*\*Not yet exercised\.\*\*[\s\S]*?\n\n/);
  assert.ok(paragraph, 'a "Not yet exercised" paragraph');
  const text = paragraph[0].replace(/\s+/g, ' ');
  assert.match(text, /^\*\*Not yet exercised\.\*\* Four things/);
  assert.match(text, /gh attestation verify --bundle \.\.\. --custom-trusted-root/);
  assert.match(text, /gh attestation trusted-root/);
  assert.match(text, /JSON field that carries the source digest/);
  assert.match(text, /`GITHUB_SHA` on an annotated-tag push is the commit and not the tag object/);
  assert.match(text, /fails closed/);
  assert.match(text, /first live tag/);
  assert.match(section, /broker-v\*/);
});

// --- what the attestation is said to prove ----------------------------------

const releaseRaw = fs.readFileSync(path.join(WORKFLOWS, 'broker-release.yml'), 'utf-8');
const flatten = (text) => text.replace(/^[ \t]*#[ \t]?/gm, '').replace(/\s+/g, ' ');

test('the attestation is described as showing the run and the tag commit, not a clean build', () => {
  const header = flatten(releaseRaw.slice(0, releaseRaw.indexOf('\non:')));
  const flat = section.replace(/\s+/g, ' ');
  for (const [where, text] of [
    ['the runbook', flat],
    ['the workflow header', header],
  ]) {
    assert.match(text, /commit the tag named when the run started/, `${where}: which commit`);
    assert.match(text, /which workflow run produced the bytes/, `${where}: which run`);
    assert.match(text, /does not show the bytes are a clean build/, `${where}: the limit`);
  }
  assert.doesNotMatch(
    flat,
    /built by `broker-release\.yml` at `refs\/tags\/broker-vX\.Y\.Z` from the commit that tag names/,
    'the runbook no longer says the bytes were built from the tag commit'
  );
  assert.doesNotMatch(
    header,
    /this workflow, at this tag, from this commit/,
    'the header no longer says the bytes were built from the tag commit'
  );
});

test('the workflow says next to --expect-sha that GITHUB_SHA on an annotated tag is unexercised', () => {
  const lines = releaseRaw.split('\n');
  const python = lines.findIndex((line) => line.includes('python3 -I services/broker/release/'));
  assert.ok(python > -1, 'the tag check invocation');
  assert.ok(
    lines.slice(python, python + 8).some((line) => line.includes('--expect-sha "${GITHUB_SHA}"')),
    '--expect-sha "${GITHUB_SHA}" is part of that invocation'
  );
  const comment = [];
  for (let i = python - 1; i >= 0 && /^\s*#/.test(lines[i]); i--) comment.unshift(lines[i]);
  const text = flatten(comment.join('\n'));
  assert.match(text, /unexercised/i);
  assert.match(text, /GITHUB_SHA/);
  assert.match(text, /annotated-tag push/);
  assert.match(text, /commit and not the tag object/);
  assert.match(text, /fails closed/);
  assert.match(text, /first live tag/);
});

// --- the ancestor check, run -----------------------------------------------

const COMMIT = 'a'.repeat(40);

function runAncestorCheck({ sourceCommit = COMMIT, body = '', curlExit = '', omitField = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-ancestor-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'curl'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_ARGS_FILE"\n' +
        'if [ -n "$STUB_CURL_EXIT" ]; then exit "$STUB_CURL_EXIT"; fi\nprintf \'%s\' "$STUB_BODY"\n',
      { mode: 0o755 }
    );
    const certificate = omitField ? {} : { sourceRepositoryDigest: sourceCommit };
    fs.writeFileSync(
      path.join(dir, 'verified.json'),
      JSON.stringify([{ verificationResult: { signature: { certificate } } }])
    );
    fs.writeFileSync(path.join(dir, 'check.sh'), ancestorBlock());
    const argsFile = path.join(dir, 'curl-args');
    const result = spawnSync('bash', ['check.sh'], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        STUB_ARGS_FILE: argsFile,
        STUB_BODY: body,
        STUB_CURL_EXIT: curlExit,
      },
    });
    assert.ok(!result.error, `bash ran: ${result.error}`);
    return {
      status: result.status,
      stderr: result.stderr,
      curlArgs: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf-8') : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the ancestor check passes a commit that is behind or identical to main', () => {
  for (const status of ['behind', 'identical']) {
    const run = runAncestorCheck({ body: JSON.stringify({ status }) });
    assert.equal(run.status, 0, `${status} passes: ${run.stderr}`);
    assert.ok(
      run.curlArgs.includes(`${COMPARE_URL}${COMMIT}`),
      'asked the compare API about the attested commit'
    );
  }
});

test('the ancestor check fails the deploy on anything else', () => {
  const cases = {
    ahead: { body: '{"status":"ahead"}' },
    diverged: { body: '{"status":"diverged"}' },
    'an empty answer': { body: '' },
    'a malformed answer': { body: 'not json' },
    'an answer with no status': { body: '{}' },
    'a null status': { body: '{"status":null}' },
    'a failed request': { body: '{"status":"behind"}', curlExit: '22' },
  };
  for (const [name, input] of Object.entries(cases)) {
    const run = runAncestorCheck(input);
    assert.notEqual(run.status, 0, `${name} fails the deploy`);
  }
});

test('a source commit that is not a 40-hex sha is refused before any request', () => {
  for (const sourceCommit of [
    'abc123',
    'A'.repeat(40),
    `${'a'.repeat(39)}/`,
    `${'a'.repeat(40)}0`,
    '../../x',
    '',
    // jq -r prints a newline for the escaped one: the first line is a valid
    // sha, so a line-matching grep would let the whole value through.
    `${'a'.repeat(40)}\nzz`,
    `zz\n${'a'.repeat(40)}`,
  ]) {
    const run = runAncestorCheck({ sourceCommit, body: '{"status":"behind"}' });
    assert.notEqual(run.status, 0, `${JSON.stringify(sourceCommit)} is refused`);
    assert.equal(run.curlArgs, null, `${JSON.stringify(sourceCommit)}: no request was made`);
  }
  const missing = runAncestorCheck({ omitField: true, body: '{"status":"behind"}' });
  assert.notEqual(missing.status, 0, 'a missing source digest field is refused');
  assert.equal(missing.curlArgs, null, 'no request was made');
});

test('the ancestor check asks about refs/heads/main, never a bare main', () => {
  const run = runAncestorCheck({ body: '{"status":"behind"}' });
  assert.equal(run.status, 0, run.stderr);
  const url = run.curlArgs.split('\n').find((arg) => arg.startsWith('https://'));
  assert.equal(url, `${COMPARE_URL}${COMMIT}`);
  assert.doesNotMatch(url, /compare\/main\.\.\./);
});

// --- fail fast: a failed step stops the block --------------------------------

test('both verify blocks start with set -euo pipefail', () => {
  for (const [name, block] of [
    ['the attestation verify block', verifyBlock()],
    ['the ancestor check block', ancestorBlock()],
  ]) {
    assert.ok(block.startsWith('set -euo pipefail\n'), `${name} starts with set -euo pipefail`);
  }
});

// Runs the attestation verify block with stub curl, gh and sha256sum on PATH.
// The stub sha256sum leaves a marker file, so a run that reached the digest
// check is visible whatever the exit status says.
function runVerifyBlock({ attestExit = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-verify-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const stub = (name, body) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('curl', 'exit 0');
    stub(
      'gh',
      'if [ "$2" = "verify" ] && [ -n "$STUB_ATTEST_EXIT" ]; then exit "$STUB_ATTEST_EXIT"; fi\n' +
        'if [ "$2" = "verify" ]; then printf \'[]\'; fi\nexit 0'
    );
    stub('sha256sum', 'cat > /dev/null\n: > "$STUB_MARKER_FILE"\nexit 0');
    fs.writeFileSync(path.join(dir, 'verify.sh'), verifyBlock());
    const marker = path.join(dir, 'digest-checked');
    const result = spawnSync('bash', ['verify.sh'], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        VERSION: '1.2.3',
        PINNED_SHA256: 'b'.repeat(64),
        STUB_ATTEST_EXIT: attestExit,
        STUB_MARKER_FILE: marker,
      },
    });
    assert.ok(!result.error, `bash ran: ${result.error}`);
    return { status: result.status, stderr: result.stderr, digestChecked: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the verify block reaches the digest check when the attestation verifies', () => {
  const run = runVerifyBlock({});
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.digestChecked, 'the digest check ran (the control for the next test)');
});

test('a failed attestation verify stops the block before the digest check', () => {
  const run = runVerifyBlock({ attestExit: '1' });
  assert.notEqual(run.status, 0, 'the block fails');
  assert.ok(!run.digestChecked, 'the digest check did not run after the failed verify');
});
