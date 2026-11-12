// Every workflow that publishes an @branchleft package signs the tarball it
// publishes. These checks pin what a mistake would silently undo: the shared
// attest action is called, pinned to the reviewed commit, in the same job that
// packs and publishes, between the pack and the publish; the publish takes the
// packed file and nothing else; the identity is a literal equal to this file's
// own path; and the two signing grants sit on that one job and nowhere else.
// What the action checks is in branchLeft/github-workflows, with its own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const REPO = 'branchLeft/ghost-platform';
const ACTION = 'branchLeft/github-workflows/.github/actions/attest-npm-tarball';
const ACTION_SHA = 'a2175a416b57f950fed891837f88f2d1a31e00f4';
const ACTION_LINE = `${ACTION}@${ACTION_SHA} # v1.2.0`;
const SIGNING = ['id-token: write', 'attestations: write'];

const uncommented = (file) =>
  fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/^[ \t]*#.*$/gm, '');

// The text of one job: from its `  name:` line to the next job or the end.
function jobBlock(text, name) {
  const jobsAt = text.indexOf('\njobs:');
  assert.ok(jobsAt > -1, 'workflow has a jobs section');
  const jobs = text.slice(jobsAt + 1);
  const start = jobs.search(new RegExp(`^  ${name}:\\n`, 'm'));
  assert.ok(start > -1, `workflow has a ${name} job`);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// The steps of a job as { name, text }, in order.
function steps(job) {
  return job
    .split(/^ {6}- (?=name: )/m)
    .slice(1)
    .map((text) => ({ name: text.match(/^name: (.*)$/m)[1], text }));
}

// The lines of a job's own `permissions:` block (job level, six-space grants).
function permissions(job) {
  const block = job.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m);
  assert.ok(block, 'job has a permissions block');
  return block[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim());
}

const WORKFLOWS = [
  {
    file: 'publish-render-core.yml',
    job: 'publish',
    ref: 'refs/tags/render-core-v${version}',
    publish: /^ {8}run: pnpm publish "\$\{TARBALL\}" --no-git-checks$/m,
    guarded: false,
  },
  {
    file: 'publish-tenant-package.yml',
    job: 'publish',
    ref: 'refs/tags/v${version}',
    publish: /^ {8}run: pnpm publish "\$\{TARBALL\}" --no-git-checks$/m,
    guarded: false,
  },
  {
    file: 'speckify.yml',
    job: 'publish',
    ref: 'refs/heads/main',
    publish: /npm publish "\$\{TARBALL\}" --registry https:\/\/npm\.pkg\.github\.com$/m,
    guarded: true,
  },
];

for (const { file, job: jobName, ref, publish, guarded } of WORKFLOWS) {
  const text = uncommented(`.github/workflows/${file}`);
  const job = jobBlock(text, jobName);
  const list = steps(job);
  const at = (needle) => list.findIndex((s) => s.name.startsWith(needle));
  const attest = list[at('Attest the tarball')];

  test(`${file}: the shared attest action is called once, pinned to the reviewed commit`, () => {
    assert.ok(attest, 'the job has an attest step');
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)]
      .map((m) => m[1])
      .filter((u) => u.startsWith(ACTION));
    assert.deepEqual(uses, [ACTION_LINE]);
    assert.ok(attest.text.includes(`uses: ${ACTION_LINE}`), 'it is called in the publish job');
  });

  test(`${file}: the attest sits after the pack and before the publish`, () => {
    const pack = at('Pack');
    const publishAt = at('Publish');
    assert.ok(pack > -1 && publishAt > -1, 'the job packs and publishes');
    assert.ok(pack < at('Attest the tarball') && at('Attest the tarball') < publishAt);
  });

  test(`${file}: the publish takes the packed file, not the source directory`, () => {
    const step = list[at('Publish')];
    assert.match(step.text, publish);
    assert.match(step.text, /TARBALL: \$\{\{ steps\.pack\.outputs\.tarball \}\}/);
    assert.match(attest.text, /tarball: \$\{\{ steps\.pack\.outputs\.tarball \}\}/);
    assert.doesNotMatch(
      text,
      /(?:pnpm|npm) publish(?! "\$\{TARBALL\}")/,
      'no publish of a directory'
    );
  });

  test(`${file}: the identity is literal, equal to this file, never read from the run`, () => {
    assert.deepEqual(
      [...attest.text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]),
      [`${REPO}/.github/workflows/${file}`]
    );
    assert.deepEqual(
      [...attest.text.matchAll(/^\s*repo: (\S+)\s*$/gm)].map((m) => m[1]),
      [REPO]
    );
    assert.doesNotMatch(attest.text, /workflow_ref|job_workflow_ref|github\./);
    if (guarded) {
      assert.match(attest.text, /^ {10}ref: refs\/heads\/main$/m);
    } else {
      assert.match(attest.text, /^ {10}ref: \$\{\{ steps\.pack\.outputs\.ref \}\}$/m);
      const packText = list[at('Pack')].text;
      assert.ok(
        packText.includes(`"ref=${ref}"`),
        `the ref is built from the packed version: ${ref}`
      );
    }
  });

  test(`${file}: the job holds exactly its two signing grants beside its own`, () => {
    const grants = permissions(job);
    for (const grant of SIGNING) assert.ok(grants.includes(grant), `${grant} is on the job`);
    assert.deepEqual(
      grants.filter((g) => !SIGNING.includes(g)),
      ['contents: read', 'packages: write']
    );
  });

  test(`${file}: the signing grants are on no other job and not on the workflow`, () => {
    assert.equal(text.match(/id-token:/g).length, 1, 'id-token appears once');
    assert.equal(text.match(/attestations:/g).length, 1, 'attestations appears once');
    const before = text.slice(0, text.indexOf('\njobs:'));
    assert.doesNotMatch(before, /id-token|attestations/);
  });

  test(`${file}: the credentials are the run's own token, unchanged`, () => {
    const names = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.ok(
      names.every((n) => n === 'GITHUB_TOKEN'),
      `unexpected secret: ${names}`
    );
  });
}

test('speckify attests and publishes only a version that was packed, under one condition', () => {
  const job = jobBlock(uncommented('.github/workflows/speckify.yml'), 'publish');
  const list = steps(job);
  const condition = (name) =>
    list.find((s) => s.name.startsWith(name)).text.match(/^ {8}if: (.*)$/m)?.[1];
  assert.equal(condition('Attest the tarball'), "steps.pack.outputs.publish == 'true'");
  assert.equal(condition('Publish to GitHub Packages'), "steps.pack.outputs.publish == 'true'");
});

test('speckify check job is not given the signing grants', () => {
  const check = jobBlock(uncommented('.github/workflows/speckify.yml'), 'check');
  for (const grant of SIGNING) assert.ok(!permissions(check).includes(grant));
});
