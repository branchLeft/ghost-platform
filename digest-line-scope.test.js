// Guards scripts/digest-line-scope.js and the workflow that runs it. Each case
// is a change that a quiet edit to the check could let through while the
// workflow still ran green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, main } from './scripts/digest-line-scope.js';

const SCRIPT = fileURLToPath(new URL('./scripts/digest-line-scope.js', import.meta.url));
const WORKFLOW = fileURLToPath(
  new URL('./.github/workflows/digest-line-scope.yml', import.meta.url)
);

const MACHINE = 'digest-bump-bot[bot]';
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
  assert.match(r.reason, /compared identity digest-bump-bot\[bot\]; author someone-else/);
});

test('no configured machine identity is a no-op that says so', () => {
  const r = run({ machineLogin: '', nameStatus: 'M\tREADME.md\n', patch: '' });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
  assert.match(r.reason, /no machine identity configured: this check is a no-op/);
});

test('the identity must be in the <slug>[bot] form; the CLI form is refused for every PR', () => {
  for (const bad of ['app/digest-bump-bot', 'digest-bump-bot', 'digest-bump-bot[bot]x']) {
    const r = run({ machineLogin: bad });
    assert.equal(r.applies, true, bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.problems[0], /must hold exactly <slug>\[bot\]/);
  }
});

test('an empty author fails closed when an identity is configured', () => {
  for (const author of ['', '   ', undefined]) {
    const r = run({ author });
    assert.equal(r.applies, true);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /could not be read; refusing/);
  }
});

test('the machine identity may bump only the FROM tag and digest', () => {
  const r = run();
  assert.equal(r.applies, true);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.identity, MACHINE);
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

// Integration: a scratch repository plays the pull request. The script is run
// from this (base) copy against the scratch repository, the way the workflow
// runs it from the base checkout. A pull request that edits the check itself
// must be refused.
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-line-scope-'));
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => {
    git('add', '-A');
    const r = git('commit', '-q', '-m', msg);
    assert.equal(r.status, 0, r.stderr);
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  return { dir, git, write, commit };
}

function checkPr(dir, base, head) {
  const env = { ...process.env, MACHINE_LOGIN: MACHINE };
  delete env.GITHUB_STEP_SUMMARY;
  return spawnSync(
    process.execPath,
    [SCRIPT, '--base', base, '--head', head, '--author', MACHINE],
    { cwd: dir, env, encoding: 'utf8' }
  );
}

function prFixture(editPr) {
  const repo = scratchRepo();
  try {
    repo.write('Dockerfile', `${FROM_OLD}\nRUN true\n`);
    repo.write('scripts/digest-line-scope.js', 'export const check = 1;\n');
    repo.write('.github/workflows/digest-line-scope.yml', 'name: x\n');
    const base = repo.commit('base');
    repo.git('checkout', '-q', '-b', 'pr');
    editPr(repo);
    const head = repo.commit('pr');
    return { ...repo, result: checkPr(repo.dir, base, head) };
  } catch (e) {
    fs.rmSync(repo.dir, { recursive: true, force: true });
    throw e;
  }
}

function cleanup(repo) {
  fs.rmSync(repo.dir, { recursive: true, force: true });
}

test('integration: a clean digest bump passes the base-branch check', () => {
  const r = prFixture((repo) => repo.write('Dockerfile', `${FROM_NEW}\nRUN true\n`));
  try {
    assert.equal(r.result.status, 0, r.result.stdout + r.result.stderr);
    assert.match(r.result.stdout, /PASS: compared identity digest-bump-bot\[bot\]/);
  } finally {
    cleanup(r);
  }
});

test('integration: a PR that edits the check script alongside the bump is refused', () => {
  const r = prFixture((repo) => {
    repo.write('Dockerfile', `${FROM_NEW}\nRUN true\n`);
    repo.write('scripts/digest-line-scope.js', 'process.exit(0);\n');
  });
  try {
    assert.equal(r.result.status, 1, r.result.stdout);
    assert.match(r.result.stdout, /exactly one modified Dockerfile/);
  } finally {
    cleanup(r);
  }
});

test('integration: a PR that edits only the check script is refused', () => {
  const r = prFixture((repo) => repo.write('scripts/digest-line-scope.js', 'process.exit(0);\n'));
  try {
    assert.equal(r.result.status, 1, r.result.stdout);
    assert.match(r.result.stdout, /REFUSED/);
  } finally {
    cleanup(r);
  }
});

test('integration: a PR that edits the workflow file is refused', () => {
  const r = prFixture((repo) => {
    repo.write('Dockerfile', `${FROM_NEW}\nRUN true\n`);
    repo.write('.github/workflows/digest-line-scope.yml', 'name: no-op\n');
  });
  try {
    assert.equal(r.result.status, 1, r.result.stdout);
    assert.match(r.result.stdout, /REFUSED/);
  } finally {
    cleanup(r);
  }
});

test('the unset identity writes a visible summary and a warning annotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-line-scope-sum-'));
  const summary = path.join(dir, 'summary.md');
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  let code;
  try {
    code = main(
      ['--base', 'HEAD', '--head', 'HEAD', '--author', MACHINE],
      {
        GITHUB_STEP_SUMMARY: summary,
      },
      process.cwd()
    );
  } finally {
    process.stdout.write = realWrite;
  }
  assert.equal(code, 0);
  const out = chunks.join('');
  assert.match(
    out,
    /::warning title=Digest-only line scope::no machine identity configured: this check is a no-op/
  );
  assert.match(
    fs.readFileSync(summary, 'utf8'),
    /no machine identity configured: this check is a no-op/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the workflow runs from the base branch, reads the head only as data, and holds no secrets', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /^on:\n {2}pull_request_target:/m);
  assert.doesNotMatch(text, /^ {2}pull_request:/m);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(text, /secrets\./);
  // The checkout must be the base commit, never the pull request head or merge.
  const start = text.indexOf('uses: actions/checkout@');
  const block = text.slice(start, text.indexOf('\n      - name:', start));
  const ref = block.match(/^\s+ref:\s*(.+)$/m);
  assert.ok(ref, 'checkout has an explicit ref');
  assert.equal(ref[1].trim(), '${{ github.event.pull_request.base.sha }}');
  assert.doesNotMatch(block, /head/);
  assert.match(
    text,
    /git fetch --no-tags --no-recurse-submodules origin "refs\/pull\/\$\{PR_NUMBER\}\/head"/
  );
  assert.match(text, /test "\$\(git rev-parse FETCH_HEAD\)" = "\$HEAD_SHA"/);
  for (const m of text.matchAll(/uses:\s*(\S+)/g)) {
    assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned action ${m[1]}`);
  }
  assert.doesNotMatch(text, /cache:|upload-artifact|download-artifact/);
});
