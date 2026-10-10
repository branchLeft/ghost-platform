// Guards scripts/digest-line-scope.js, the required check that holds the
// digest-only merge route to one line. Each case is a change that a quiet edit
// to the check could let through while the workflow still ran green.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from './scripts/digest-line-scope.js';

const MACHINE = 'DIGEST_MACHINE_LOGIN_PLACEHOLDER';
const OLD_DIGEST = 'a'.repeat(64);
const NEW_DIGEST = 'b'.repeat(64);
const FROM_OLD = `FROM ghost:6.55.0-alpine@sha256:${OLD_DIGEST}`;
const FROM_NEW = `FROM ghost:6.56.0-alpine@sha256:${NEW_DIGEST}`;

const NAME_OK = 'M\tDockerfile\n';

function patchOf(removed, added, { hunks = 1 } = {}) {
  const one = `diff --git a/Dockerfile b/Dockerfile
index 1111111..2222222 100644
--- a/Dockerfile
+++ b/Dockerfile
`;
  const hunk = `@@ -13 +13 @@
-${removed}
+${added}
`;
  return one + hunk.repeat(hunks);
}

function run(overrides = {}) {
  return evaluate({
    author: MACHINE,
    machineLogin: MACHINE,
    nameStatus: NAME_OK,
    patch: patchOf(FROM_OLD, FROM_NEW),
    ...overrides,
  });
}

test('an author who is not the machine identity is never refused', () => {
  const r = run({ author: 'someone-else', nameStatus: 'M\tREADME.md\n', patch: '' });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('no configured machine identity means the check does not apply', () => {
  const r = run({ machineLogin: '', nameStatus: 'M\tREADME.md\n', patch: '' });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('the machine identity may bump only the FROM tag and digest', () => {
  const r = run();
  assert.equal(r.applies, true);
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('the author match is case-insensitive', () => {
  const r = run({ author: MACHINE.toUpperCase() });
  assert.equal(r.applies, true);
  assert.equal(r.ok, true);
});

test('a change to any other file is refused', () => {
  const r = run({ nameStatus: 'M\tDockerfile\nM\tapp.js\n' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /exactly one modified Dockerfile/);
});

test('an added, deleted or renamed Dockerfile is refused', () => {
  for (const status of ['A\tDockerfile', 'D\tDockerfile', 'R100\tDockerfile']) {
    const r = run({ nameStatus: `${status}\n` });
    assert.equal(r.ok, false, status);
  }
});

test('a mode change to the Dockerfile is refused', () => {
  const patch = patchOf(FROM_OLD, FROM_NEW).replace(
    'index 1111111',
    'old mode 100644\nnew mode 100755\nindex 1111111'
  );
  const r = run({ patch });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /header changed/);
});

test('a second hunk is refused', () => {
  const r = run({ patch: patchOf(FROM_OLD, FROM_NEW, { hunks: 2 }) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /exactly one hunk/);
});

test('a change to a line other than FROM is refused', () => {
  const r = run({
    patch: patchOf('RUN apt-get update', 'RUN apt-get update && true'),
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /FROM image:tag@sha256:digest/);
});

test('an image name change is refused even with a valid digest', () => {
  const r = run({
    patch: patchOf(FROM_OLD, `FROM evil:6.56.0-alpine@sha256:${NEW_DIGEST}`),
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /image name changed/);
});

test('a FROM line that gains a stage alias is refused', () => {
  const r = run({ patch: patchOf(FROM_OLD, `${FROM_NEW} AS runtime`) });
  assert.equal(r.ok, false);
});

test('a FROM line that drops its digest is refused', () => {
  const r = run({ patch: patchOf(FROM_OLD, 'FROM ghost:6.56.0-alpine') });
  assert.equal(r.ok, false);
});

test('a hunk that adds a line alongside the FROM change is refused', () => {
  const patch = `diff --git a/Dockerfile b/Dockerfile
index 1111111..2222222 100644
--- a/Dockerfile
+++ b/Dockerfile
@@ -13 +13,2 @@
-${FROM_OLD}
+${FROM_NEW}
+RUN echo injected
`;
  const r = run({ patch });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /exactly one line with exactly one line/);
});

test('a PR that changes nothing in the Dockerfile is refused', () => {
  const r = run({ nameStatus: '', patch: '' });
  assert.equal(r.ok, false);
});

test('the workflow runs the check on pull requests with read-only contents', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(
    new URL('./.github/workflows/digest-line-scope.yml', import.meta.url),
    'utf8'
  );
  assert.match(text, /^on:\n {2}pull_request:/m);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.match(text, /scripts\/digest-line-scope\.js/);
  for (const m of text.matchAll(/uses:\s*(\S+)/g)) {
    assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned action ${m[1]}`);
  }
});
