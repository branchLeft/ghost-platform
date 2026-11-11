// refresh-lockfile.yml reads a package token, checks out a branch's files and
// hands a lockfile back. These checks pin what a mistake there would break
// without a failing run to notice: it must hold read-only permissions and
// write nothing, its dispatch inputs must reach the shell only through env,
// its validation must refuse a hostile ref or directory, and the list of
// projects it offers must be the pnpm projects that consume @branchleft
// packages. The validation step is extracted from the live YAML and executed,
// not reimplemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const FILE = path.join(ROOT, '.github', 'workflows', 'refresh-lockfile.yml');
const raw = fs.readFileSync(FILE, 'utf-8');
const body = raw.replace(/^[ \t]*#.*$/gm, '');

// Every `run: |` block, dedented, with the step name that owns it.
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let stepName = '';
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\s*- name: (.*)$/);
    if (name) stepName = name[1].trim();
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) {
      const out = [];
      let base = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') {
          out.push('');
          continue;
        }
        const indent = lines[j].match(/^ */)[0].length;
        if (base === null) base = indent;
        if (indent < base) break;
        out.push(lines[j].slice(base));
      }
      blocks.push({ stepName, script: out.join('\n') });
    }
  }
  return blocks;
}

function optionsList(text) {
  const m = text.match(/options:\n((?:[ \t]+- .*\n)+)/);
  assert.ok(m, 'project_dir has an options list');
  return [...m[1].matchAll(/- (\S+)/g)].map((x) => x[1]);
}

const validateScript = runBlocks(body).find(
  (b) => b.stepName === 'Validate ref and project_dir'
)?.script;

function runValidate(script, ref, projectDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lockfile-'));
  try {
    const out = path.join(dir, 'output');
    fs.writeFileSync(out, '');
    const result = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH, REF: ref, PROJECT_DIR: projectDir, GITHUB_OUTPUT: out },
      encoding: 'utf-8',
    });
    return { status: result.status, output: fs.readFileSync(out, 'utf-8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runs only on workflow_dispatch', () => {
  const on = body.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m);
  assert.ok(on, 'has an on: block');
  const triggers = [...on[1].matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('holds read-only permissions and writes nothing', () => {
  assert.match(body, /^permissions: \{\}$/m);
  assert.doesNotMatch(body, /:\s*write\b/);
  assert.doesNotMatch(body, /id-token/);
  const refresh = body.slice(body.indexOf('\n  refresh:'));
  assert.match(refresh, /permissions:\n {6}contents: read\n {6}packages: read\n/);
  for (const forbidden of [
    'git commit',
    'git push',
    'git add',
    'createCommitOnBranch',
    'gh api',
    'gh pr',
  ]) {
    assert.ok(!body.includes(forbidden), `must not contain: ${forbidden}`);
  }
});

test('uses only the run token, and checks out without persisting it', () => {
  const secrets = [...body.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((s) => s === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
  assert.match(body, /persist-credentials: false/);
});

test('no expression is expanded inside any run block', () => {
  const blocks = runBlocks(body);
  assert.ok(blocks.length >= 3);
  for (const { stepName, script } of blocks) {
    assert.ok(!script.includes('${{'), `step "${stepName}" expands an expression in run:`);
  }
});

test('every action is pinned to a full commit sha', () => {
  const uses = [...body.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) {
    assert.match(u, /@[0-9a-f]{40}$/, `unpinned action: ${u}`);
  }
});

test('the offered projects match the validation list and the repo', () => {
  const options = optionsList(body);
  const caseList = [
    ...validateScript
      .match(/case "\$PROJECT_DIR" in\n([\s\S]*?)\n\s*\*\)/)[1]
      .matchAll(/(?:^|\|)\s*(\S+?)\s*(?=\||\))/gm),
  ].map((m) => m[1]);
  assert.deepEqual([...caseList].sort(), [...options].sort(), 'options and case list differ');

  // Every pnpm project that has a lockfile and consumes a @branchleft package.
  const tracked = execFileSync('git', ['ls-files', '--', '*pnpm-lock.yaml'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean)
    .map((p) => path.dirname(p));
  const consumers = tracked.filter((dir) => {
    const pkg = fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf-8');
    return pkg.includes('"@branchleft/');
  });
  assert.deepEqual([...options].sort(), [...consumers].sort());

  for (const dir of options) {
    assert.ok(fs.existsSync(path.join(ROOT, dir, '.nvmrc')), `${dir} has no .nvmrc`);
  }
});

test('validation accepts a plain branch and a listed project', () => {
  const ok = runValidate(validateScript, 'pin-render-core-0.4.0', 'infra/tenant');
  assert.equal(ok.status, 0);
  assert.match(ok.output, /^ref=pin-render-core-0.4.0$/m);
  assert.match(ok.output, /^project_dir=infra\/tenant$/m);
  assert.equal(runValidate(validateScript, 'feature/a_b.c-1', '.').status, 0);
});

test('validation refuses a hostile or malformed ref', () => {
  const bad = [
    '',
    'refs/heads/main',
    '-rf',
    '.hidden',
    'a..b',
    'a/',
    'a//b',
    'x.lock',
    'a b',
    'a;b',
    'a$(id)',
    'a`id`',
    'a\nb',
    'a"b',
    "a'b",
    'a|b',
    'a&b',
    'x'.repeat(201),
  ];
  for (const ref of bad) {
    const r = runValidate(validateScript, ref, 'infra/tenant');
    assert.notEqual(r.status, 0, `accepted ref ${JSON.stringify(ref)}`);
    assert.equal(r.output, '', `wrote an output for ref ${JSON.stringify(ref)}`);
  }
});

test('validation refuses a project_dir outside the list', () => {
  const bad = [
    '',
    'infra',
    'infra/tenant/',
    'infra/../secrets',
    '../etc',
    '/etc',
    'infra/tenant; id',
    'infra/tenant\n.',
    '$(id)',
    'services/unknown',
    'Infra/tenant',
    '..',
    '-rf',
  ];
  for (const dir of bad) {
    const r = runValidate(validateScript, 'main', dir);
    assert.notEqual(r.status, 0, `accepted project_dir ${JSON.stringify(dir)}`);
    assert.equal(r.output, '', `wrote an output for project_dir ${JSON.stringify(dir)}`);
  }
});
