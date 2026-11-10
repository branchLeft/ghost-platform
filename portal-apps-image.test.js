import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The portal-apps image is what a deployment pins, so its inputs are controls:
// the base image is digest-pinned to the one the image scan judged, the build
// tool is an exact version, npm is gone from the final image, and the pnpm
// store never reaches it.
const DOCKERFILE = path.join(import.meta.dirname, 'portal', 'Dockerfile');

// The base the scan of 2026-11-10 judged: node:26.13.0-alpine, linux/amd64 manifest.
const SCANNED_BASE =
  'node:26.13.0-alpine@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a';
const PNPM = 'pnpm@11.28.11';

// Whole-line comments and trailing ones (a `#` after whitespace) both go, so
// text inside a comment can never satisfy a check.
const withoutComments = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');

const dockerfile = withoutComments(fs.readFileSync(DOCKERFILE, 'utf8'));

test('the base image is one FROM line, pinned by digest to the scanned digest', () => {
  const froms = dockerfile.split('\n').filter((line) => /^\s*FROM\s/.test(line));
  assert.deepEqual(froms, [`FROM ${SCANNED_BASE}`]);
});

test('the base image is never a bare tag', () => {
  assert.doesNotMatch(dockerfile, /^FROM\s+[^\s@]+\s*$/m);
});

test('the global pnpm is an exact version, and nothing else is installed globally', () => {
  const global = /^\s*sh -eu -c 'npm install --global (.+?);/m.exec(dockerfile);
  assert.ok(global, 'the install RUN installs pnpm globally');
  assert.deepEqual(global[1].trim().split(/\s+/), [PNPM]);
});

test('the pnpm version matches the packageManager pin of the packages it builds', () => {
  for (const dir of ['portal/apps', 'portal/data', 'services/identity', 'services/request-guard']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, dir, 'package.json'), 'utf8'));
    assert.equal(pkg.packageManager, PNPM, `${dir} packageManager`);
  }
});

test('npm is removed in the same RUN that installs with it', () => {
  const runs = dockerfile.split(/^RUN\s/m).slice(1);
  const installRun = runs.find((run) => run.includes('npm install --global'));
  assert.ok(installRun, 'a RUN installs with npm');
  assert.match(installRun, /rm -rf \/usr\/local\/lib\/node_modules\/npm\b/);
  assert.ok(installRun.indexOf('npm install --global') < installRun.indexOf('rm -rf /usr/local/lib/node_modules/npm'));
});

test('the pnpm store is removed in the same RUN that installs into it', () => {
  const runs = dockerfile.split(/^RUN\s/m).slice(1);
  const installRun = runs.find((run) => run.includes('pnpm install'));
  assert.ok(installRun, 'a RUN installs with pnpm');
  assert.match(installRun, /pnpm store path/);
  assert.match(installRun, /rm -rf "\$store"/);
  assert.ok(installRun.indexOf('pnpm install') < installRun.indexOf('rm -rf "$store"'));
});

test('zlib is upgraded past CVE-2026-4738 before anything else runs', () => {
  assert.match(dockerfile, /^RUN apk upgrade --no-cache zlib$/m);
});
