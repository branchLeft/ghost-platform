// The consumer check on the @branchleft packages this repository installs runs
// on every pull request and every push to main. These checks pin what a mistake
// would silently undo: the shared verify action is called once, pinned to the
// reviewed commit with its version comment; it is scanned over the whole tree,
// never a narrowed root; the job holds exactly the two read grants and nothing
// else; the job does not pass a token or an identity of its own; and the
// workflow is not path filtered or made optional with a condition.
// What the action checks is in branchLeft/github-workflows, with its own tests.
//
// `problems(text)` is the whole rule, so the self-tests below can break one
// property at a time in a copy of the real file and require a red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILE = '.github/workflows/package-attestations-ci.yml';
const ACTION = 'branchLeft/github-workflows/.github/actions/verify-package-attestations';
const ACTION_SHA = '2c34b90b367fd160bb01d311d29224d250460086';
const ACTION_LINE = `${ACTION}@${ACTION_SHA} # v1.2.1`;
const GRANTS = ['contents: read', 'packages: read'];

const uncommented = (text) => text.replace(/^[ \t]*#.*$/gm, '');

// The text of the one job: from `  verify:` to the next job or the end.
function jobBlock(text) {
  const jobsAt = text.indexOf('\njobs:');
  if (jobsAt === -1) return null;
  const jobs = text.slice(jobsAt + 1);
  const start = jobs.search(/^ {2}verify:\n/m);
  if (start === -1) return null;
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// The lines of the job's own `permissions:` block (job level, six-space grants).
function jobGrants(job) {
  const block = job.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m);
  return block
    ? block[1]
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim())
    : null;
}

export function problems(source) {
  const text = uncommented(source);
  const found = [];
  const job = jobBlock(text);
  if (job === null) return ['the workflow has no verify job'];

  const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)]
    .map((m) => m[1])
    .filter((u) => u.startsWith(ACTION));
  if (uses.length !== 1 || uses[0] !== ACTION_LINE) {
    found.push(`the verify action must be called once, exactly as ${ACTION_LINE}; got ${uses}`);
  }
  if (!job.includes(`uses: ${ACTION_LINE}`)) {
    found.push('the verify action is not a step of the verify job');
  }

  const grants = jobGrants(job);
  if (
    grants === null ||
    grants.length !== GRANTS.length ||
    !GRANTS.every((g) => grants.includes(g))
  ) {
    found.push(`the job permissions must be exactly ${GRANTS.join(' and ')}; got ${grants}`);
  }
  const before = text.slice(0, text.indexOf('\njobs:'));
  if (/id-token:|attestations:|:\s*write\b/.test(before)) {
    found.push('the workflow level grants nothing beyond contents: read');
  }
  if (/:\s*write\b|id-token:|attestations:/.test(text)) found.push('no write grant anywhere');

  const step = job.slice(job.search(/^ {6}- name: Verify package attestations$/m));
  if (/^\s+with:/m.test(step)) {
    found.push('the verify step passes no inputs: the whole tree is scanned with the run token');
  }
  if (/^\s+if:/m.test(job)) found.push('the verify job and its steps carry no condition');
  if (/^\s+continue-on-error:/m.test(text)) found.push('the verify job may not continue on error');
  if (/secrets\./.test(text)) found.push('the workflow uses no secret');

  if (!/^ {2}push:\n {4}branches: \[main\]$/m.test(text)) found.push('it must run on push to main');
  if (!/^ {2}pull_request:\n {4}branches: \[main\]$/m.test(text)) {
    found.push('it must run on pull requests to main');
  }
  if (/^\s+paths(?:-ignore)?:/m.test(text)) found.push('it must not be path filtered');
  return found;
}

const REAL = fs.readFileSync(path.join(import.meta.dirname, FILE), 'utf-8');

test('the consumer check is wired as pinned, read-only and unconditional', () => {
  assert.deepEqual(problems(REAL), []);
});

test('the verify action is SHA pinned with its version comment', () => {
  assert.ok(REAL.includes(`uses: ${ACTION_LINE}\n`));
  assert.match(ACTION_SHA, /^[0-9a-f]{40}$/);
});

function breaks(name, edit) {
  test(`self-test: ${name} is refused`, () => {
    const broken = edit(REAL);
    assert.notEqual(broken, REAL, 'the edit changed the file');
    assert.ok(problems(broken).length > 0, 'the rule went red');
  });
}

breaks('the verify step removed', (t) =>
  t.replace(/\n {6}- name: Verify package attestations\n.*\n/, '\n')
);
breaks('a tag pin instead of the commit', (t) => t.replace(`@${ACTION_SHA} # v1.2.1`, '@v1.2.1'));
breaks('the version comment dropped', (t) => t.replace(' # v1.2.1\n', '\n'));
breaks('an older commit', (t) => t.replace(ACTION_SHA, 'a2175a416b57f950fed891837f88f2d1a31e00f4'));
breaks('a third job permission', (t) =>
  t.replace('      packages: read\n', '      packages: read\n      actions: read\n')
);
breaks('packages: write', (t) =>
  t.replace('packages: read\n\n    steps', 'packages: write\n\n    steps')
);
breaks('the id-token grant', (t) =>
  t.replace('      packages: read\n', '      packages: read\n      id-token: write\n')
);
breaks('a missing job permissions block', (t) =>
  t.replace('    permissions:\n      contents: read\n      packages: read\n', '')
);
breaks('a narrowed root', (t) =>
  t.replace(/(v1\.2\.1\n)$/, '$1        with:\n          root: render-core\n')
);
breaks('a condition on the step', (t) =>
  t.replace(
    '      - name: Verify package attestations\n',
    "      - name: Verify package attestations\n        if: github.event_name == 'push'\n"
  )
);
breaks('continue-on-error', (t) =>
  t.replace('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    continue-on-error: true\n')
);
breaks('a path filter', (t) =>
  t.replace(
    '  pull_request:\n    branches: [main]\n',
    "  pull_request:\n    branches: [main]\n    paths:\n      - '**/pnpm-lock.yaml'\n"
  )
);
breaks('the push trigger removed', (t) => t.replace('  push:\n    branches: [main]\n', ''));
