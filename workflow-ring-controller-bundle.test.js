// The ring-controller release bundle is the file the ring_controller_host role pins
// by digest. These checks pin what a mistake there would silently break: the bundle
// job runs on the same tag as the package's own publish workflow and no other, it
// holds the signing grants and the release grant on its one job only, the attestation
// is the reviewed action, the build is packed twice and the two must match before
// anything is signed, and the release is created with --verify-tag and never replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, tagPatterns, uncommented } from './test-support/workflow-text.ts';

const text = uncommented('ring-controller-bundle.yml');
const sibling = uncommented('publish-ring-controller.yml');

test('runs on the ring-controller tag, the same one the sibling workflow takes', () => {
  assert.deepEqual(tagPatterns(text), tagPatterns(sibling));
  const re = globToRegex(tagPatterns(text)[0]);
  assert.ok(re.test('ring-controller-v0.1.1'));
  assert.ok(!re.test('render-core-v0.6.0'));
});

test('holds the signing grants and contents: write, on its one job only', () => {
  assert.equal(text.match(/^ {4}permissions:/gm).length, 1);
  for (const grant of ['contents: write', 'id-token: write', 'attestations: write']) {
    assert.match(text, new RegExp(`^ {6}${grant}$`, 'm'));
  }
  assert.doesNotMatch(
    text.slice(0, text.indexOf('\njobs:')),
    /permissions:|id-token|contents: write/
  );
});

test('attests through the shared npm-tarball action, pinned to its release, before the release', () => {
  assert.match(
    text,
    /uses: branchLeft\/github-workflows\/\.github\/actions\/attest-npm-tarball@f559ca696956d3d58440f56666d85f36c829c08b # v1\.2\.7/
  );
  assert.doesNotMatch(text, /actions\/attest-build-provenance@/);
  assert.ok(
    text.indexOf('- name: Attest the bundle') < text.indexOf('- name: Publish the release')
  );
});

test('packs twice and holds the two packs to the same bytes before anything is signed', () => {
  assert.match(text, /--out "\$\{RUNNER_TEMP\}\/bundle-\$\{run\}"/);
  assert.match(
    text,
    /cmp "\$\{RUNNER_TEMP\}\/bundle-a\/\$\{name\}" "\$\{RUNNER_TEMP\}\/bundle-b\/\$\{name\}"/
  );
  assert.ok(text.indexOf('cmp "') < text.indexOf('- name: Attest the bundle'));
});

test('creates its release with --verify-tag and never replaces one', () => {
  assert.match(text, /gh release create "ring-controller-v\$\{VERSION\}"/);
  assert.match(text, /--verify-tag/);
  assert.match(text, /--latest=false/);
  assert.doesNotMatch(text, /--clobber|gh release upload/);
});

test('reads no secret but the run token', () => {
  const names = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  assert.ok(
    names.every((n) => n === 'GITHUB_TOKEN'),
    `unexpected secret: ${names}`
  );
});
