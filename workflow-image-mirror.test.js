// The mirror workflow is the one job that writes third-party images into our
// registry. These checks pin what a mistake there would silently widen: the
// token it runs with, the absence of any stored credential or Docker Hub
// login, the pinned and checksum-verified copy tool, and the fact that it
// never runs on a pull request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');

function uncommented(file) {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf-8').replace(/^[ \t]*#.*$/gm, '');
}

const mirror = uncommented('image-mirror.yml');
const ci = uncommented('image-mirror-ci.yml');

test('runs on push to main and by hand, never on a pull request', () => {
  assert.match(mirror, /on:\n {2}push:\n {4}branches: \[main\]/);
  assert.match(mirror, /workflow_dispatch:/);
  assert.doesNotMatch(mirror, /pull_request/);
});

test('only the mirror job can write packages, and nothing else is writable', () => {
  assert.match(mirror, /permissions:\n {2}contents: read\n {2}packages: write\n/);
  assert.doesNotMatch(ci, /packages:\s*write/);
  assert.doesNotMatch(mirror, /(contents|id-token|actions|pull-requests): write/);
});

test('uses only the run token: no stored secret and no Docker Hub login', () => {
  const secrets = [...mirror.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((name) => name === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
  assert.doesNotMatch(mirror, /docker\.io|index\.docker\.io|DOCKERHUB|docker\/login-action/i);
  assert.doesNotMatch(mirror, /docker login/);
});

test('crane is pinned by release and verified by sha256 before it runs', () => {
  assert.match(mirror, /CRANE_VERSION: v\d+\.\d+\.\d+/);
  assert.match(mirror, /CRANE_SHA256: [0-9a-f]{64}\b/);
  const check = mirror.indexOf('sha256sum --check --strict');
  const extract = mirror.indexOf('tar -xzf');
  const login = mirror.indexOf('crane auth login');
  assert.ok(check > -1 && extract > check && login > extract);
});

test('the token reaches the login through the environment, not an expression in run', () => {
  assert.match(mirror, /REGISTRY_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  const run = mirror.match(/crane auth login[^\n]*/)[0];
  assert.doesNotMatch(run, /\$\{\{/);
  assert.match(run, /--password-stdin/);
});

test('the guard CI is credential-free and runs the guard, its self-test and the dry run', () => {
  assert.match(ci, /permissions:\n {2}contents: read\n/);
  assert.match(ci, /--self-test/);
  assert.match(ci, /assert-image-refs-on-mirror\.py --mode "\$GUARD_MODE"/);
  assert.match(ci, /mirror-images\.py --dry-run/);
  assert.match(ci, /GUARD_MODE: (warn|enforce)\b/);
});
