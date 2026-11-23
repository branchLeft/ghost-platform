// The ring-controller publish workflow is the only route from a ring-controller
// change to a registry, and a tag cut by hand is its only trigger. These checks
// pin the properties a mistake there would silently break: the tag prefix that
// keeps it apart from the other three release workflows, the tag-versus-
// package.json guard, the least-privilege token, the type check and tests that
// precede the publish, and a package.json that is actually publishable (not
// private, public access, only dist shipped, a licence file that is in the
// tarball). The attestation steps are pinned in workflow-publish-attestation.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { globToRegex, tagPatterns, uncommented } from './test-support/workflow-text.ts';

const ROOT = import.meta.dirname;
const PACKAGE_DIR = path.join(ROOT, 'services', 'ring-controller');

const ring = uncommented('publish-ring-controller.yml');
const others = {
  'v1.2.3': uncommented('publish-tenant-package.yml'),
  'render-core-v1.2.3': uncommented('publish-render-core.yml'),
  'broker-v1.2.3': uncommented('broker-release.yml'),
};

test('triggers on a ring-controller release tag only', () => {
  assert.deepEqual(tagPatterns(ring), ['ring-controller-v[0-9]+.[0-9]+.[0-9]+']);
});

test("no release workflow's tag pattern matches another's tags", () => {
  const ringRe = globToRegex(tagPatterns(ring)[0]);
  assert.ok(ringRe.test('ring-controller-v1.2.3'));
  for (const [tag, text] of Object.entries(others)) {
    const otherRe = globToRegex(tagPatterns(text)[0]);
    assert.ok(otherRe.test(tag), `${tag} starts its own release`);
    assert.ok(!ringRe.test(tag), `${tag} must not start the ring-controller release`);
    assert.ok(
      !otherRe.test('ring-controller-v1.2.3'),
      `a ring-controller tag must not start the release that takes ${tag}`
    );
  }
  const near = ['ring-controller-v1.2', 'ring-controller-v1.2.3-rc1', 'xring-controller-v1.2.3'];
  for (const bad of near) {
    assert.ok(!ringRe.test(bad), `${bad} starts nothing`);
  }
});

test('refuses a tag that names a different version than package.json', () => {
  assert.match(ring, /GITHUB_REF_NAME.*ring-controller-v\$\{PACKAGE_VERSION\}/);
  assert.match(ring, /exit 1/);
});

test('builds from services/ring-controller/ with the run token, never a stored secret', () => {
  assert.match(ring, /working-directory: services\/ring-controller\b/);
  assert.match(ring, /node-version-file: services\/ring-controller\/\.nvmrc/);
  assert.match(ring, /packages: write/);
  const secrets = [...ring.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((name) => name === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
});

test('type-checks and tests before the publish step', () => {
  const typecheck = ring.indexOf('pnpm run typecheck');
  const unit = ring.indexOf('pnpm run test:unit');
  const publish = ring.indexOf('- name: Publish\n');
  assert.ok(typecheck > -1 && unit > -1 && publish > -1);
  assert.ok(typecheck < publish && unit < publish);
});

test('keeps the dispatch as the documented escape hatch, with the tag guard on pushes', () => {
  // The tag guard is `if: github.event_name == 'push'`, as in render-core; a
  // dispatch skips it by design, so the dispatch must stay a documented escape
  // hatch for a tag push that produced no run and not a second trigger.
  assert.match(ring, /^ {2}workflow_dispatch:\s*$/m);
  assert.match(
    ring,
    /- name: Refuse a tag that disagrees with package.json\n {8}if: github\.event_name == 'push'\n/
  );
});

test('package.json is publishable under the scoped name, to GitHub Packages, shipping dist only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, '@branchleft/ghost-platform-ring-controller');
  assert.notEqual(pkg.private, true, 'a private package cannot be published');
  assert.match(pkg.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.deepEqual(pkg.files, ['dist']);
  assert.deepEqual(pkg.publishConfig, {
    registry: 'https://npm.pkg.github.com',
    access: 'public',
  });
  assert.equal(pkg.repository.directory, 'services/ring-controller');
  assert.equal(pkg.types, 'dist/index.d.ts');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'no runtime dependencies');
});

test('the licence the package names is a file inside the package directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8'));
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.equal(
    fs.readFileSync(path.join(PACKAGE_DIR, 'LICENSE'), 'utf-8'),
    fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf-8')
  );
});

test('the build config emits declarations, and only from src', () => {
  const text = fs
    .readFileSync(path.join(PACKAGE_DIR, 'tsconfig.build.json'), 'utf-8')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const config = JSON.parse(text);
  assert.equal(config.compilerOptions.declaration, true);
  assert.equal(config.compilerOptions.noEmit, false);
  assert.deepEqual(config.include, ['src/**/*.ts']);
});
