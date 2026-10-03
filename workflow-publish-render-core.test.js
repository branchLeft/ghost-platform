// The render-core publish workflow is the only route from a render-core
// change to a consumer, and a tag cut by hand is its only trigger. These
// checks pin the properties a mistake there would silently break: the tag
// prefix that keeps it apart from the tenant package's tags, the
// tag-versus-package.json guard, the least-privilege token and the type
// check and tests that precede the release step.
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

// GitHub's tag filter is a glob over the whole ref name; the only operators
// used in these two workflows are `[0-9]+` runs, which this turns into a
// regex anchored at both ends.
function globToRegex(glob) {
  return new RegExp(`^${glob.replace(/\./g, '\\.')}$`);
}

const render = uncommented('publish-render-core.yml');
const tenant = uncommented('publish-tenant-package.yml');

test('triggers on a render-core release tag only', () => {
  assert.deepEqual(tagPatterns(render), ['render-core-v[0-9]+.[0-9]+.[0-9]+']);
});

test("neither package's tag pattern matches the other's tags", () => {
  const renderRe = globToRegex(tagPatterns(render)[0]);
  const tenantRe = globToRegex(tagPatterns(tenant)[0]);
  assert.ok(renderRe.test('render-core-v1.2.3'));
  assert.ok(tenantRe.test('v1.2.3'));
  assert.ok(!renderRe.test('v1.2.3'), 'a tenant tag must not start the render-core release');
  assert.ok(
    !tenantRe.test('render-core-v1.2.3'),
    'a render-core tag must not start the tenant release'
  );
});

test('refuses a tag that names a different version than package.json', () => {
  assert.match(render, /GITHUB_REF_NAME.*render-core-v\$\{PACKAGE_VERSION\}/);
  assert.match(render, /exit 1/);
});

test('builds from render-core/ with the run token, never a stored secret', () => {
  assert.match(render, /working-directory: render-core\b/);
  assert.match(render, /node-version-file: render-core\/\.nvmrc/);
  assert.match(render, /packages: write/);
  const secrets = [...render.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((name) => name === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
});

test('type-checks and tests before the release step', () => {
  const typecheck = render.indexOf('npm run typecheck');
  const unit = render.indexOf('npm run test:unit');
  const release = render.indexOf('- name: Publish\n');
  assert.ok(typecheck > -1 && unit > -1 && release > -1);
  assert.ok(typecheck < release && unit < release);
});
