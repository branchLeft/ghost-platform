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
import path from 'node:path';

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
