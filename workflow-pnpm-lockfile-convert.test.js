// Runs the conversion program that generate-pnpm-lockfile.yml writes out,
// extracted from the live YAML rather than reimplemented, over a three
// directory fixture. Green cases prove each subcommand accepts a real pnpm 11
// conversion; each red case breaks one guard's input and must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKOUT, FINAL, IMPORTED } from './pnpm-lockfile-convert-fixtures.js';

const WORKFLOW = path.join(
  import.meta.dirname,
  '.github',
  'workflows',
  'generate-pnpm-lockfile.yml'
);
const OPEN = "<<'PYCONVERT'";
const CLOSE = 'PYCONVERT';

// The heredoc body sits at the step's indent inside `run: |`; strip it to
// column 0, the shape the runner writes to disk.
function extractProgram(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(OPEN));
  assert.notEqual(start, -1, `no line containing ${OPEN} in the workflow`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === CLOSE);
  assert.notEqual(end, -1, `no closing ${CLOSE} line after the program`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return body.map((l) => l.slice(indent)).join('\n') + '\n';
}

const program = extractProgram(fs.readFileSync(WORKFLOW, 'utf8'));

// The packages: entry for ms@2.1.3, copied out of a lockfile that holds it.
const MS_FROM_A = FINAL['pnpm-lock.yaml'].match(/ {2}ms@2\.1\.3:\n {4}resolution:[^\n]*\n/)[0];

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

// Builds the three trees the workflow works with, under a scratch directory.
function scratch(edit = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-convert-'));
  const trees = {
    checkout: { ...CHECKOUT, ...(edit.checkout || {}) },
    final: { ...FINAL, ...(edit.final || {}) },
    imports: { ...IMPORTED, ...(edit.imports || {}) },
  };
  for (const [name, files] of Object.entries(trees)) {
    for (const rel of Object.keys(files)) if (files[rel] === null) delete files[rel];
    write(path.join(dir, name), files);
  }
  fs.writeFileSync(path.join(dir, 'program.py'), program);
  return dir;
}

function convert(dir, ...args) {
  const r = spawnSync('python3', ['-I', path.join(dir, 'program.py'), ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function refused(dir, args, pattern) {
  const r = convert(dir, ...args);
  assert.equal(r.status, 1, `expected a refusal, got ${r.status}:\n${r.out}`);
  assert.match(r.out, pattern);
}

const compare = (dir) => ['compare', path.join(dir, 'checkout'), path.join(dir, 'final')];

test('the extractor finds exactly one program in the workflow', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.equal(text.split(OPEN).length - 1, 1);
  assert.match(program, /def cmd_compare/);
  assert.throws(() => extractProgram('run: |\n  echo no program here\n'));
});

test('dirs lists the root first, then each package directory', () => {
  const dir = scratch();
  const r = convert(dir, 'dirs', path.join(dir, 'checkout'));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.out.trim().split('\n'), ['.', 'a', 'b']);
});

test('stage puts file: back for a workspace link in the import tree only', () => {
  const dir = scratch();
  const r = convert(
    dir,
    'stage',
    path.join(dir, 'checkout'),
    path.join(dir, 'import-tree'),
    path.join(dir, 'final-tree')
  );
  assert.equal(r.status, 0, r.out);
  const imported = JSON.parse(fs.readFileSync(path.join(dir, 'import-tree/b/package.json')));
  assert.equal(imported.dependencies['fixture-a'], 'file:../a');
  const final = JSON.parse(fs.readFileSync(path.join(dir, 'final-tree/b/package.json')));
  assert.equal(final.dependencies['fixture-a'], 'workspace:*');
  assert.match(
    fs.readFileSync(path.join(dir, 'import-tree/.npmrc'), 'utf8'),
    /@branchleft:registry/
  );
  assert.ok(fs.existsSync(path.join(dir, 'final-tree/pnpm-workspace.yaml')));
});

test('stage refuses a workspace that does not list the converted directories', () => {
  const dir = scratch({
    checkout: { 'pnpm-workspace.yaml': 'packages:\n  - a\nsharedWorkspaceLockfile: false\n' },
  });
  refused(
    dir,
    ['stage', path.join(dir, 'checkout'), path.join(dir, 'i'), path.join(dir, 'f')],
    /do not match the directories/
  );
});

test('stage refuses a workspace without sharedWorkspaceLockfile: false', () => {
  const dir = scratch({ checkout: { 'pnpm-workspace.yaml': 'packages:\n  - a\n  - b\n' } });
  refused(
    dir,
    ['stage', path.join(dir, 'checkout'), path.join(dir, 'i'), path.join(dir, 'f')],
    /sharedWorkspaceLockfile: false/
  );
});

test('stage refuses a workspace key it does not know', () => {
  const dir = scratch({
    checkout: {
      'pnpm-workspace.yaml':
        'packages:\n  - a\n  - b\nsharedWorkspaceLockfile: false\nregistries:\n  default: https://example.invalid\n',
    },
  });
  refused(
    dir,
    ['stage', path.join(dir, 'checkout'), path.join(dir, 'i'), path.join(dir, 'f')],
    /top-level key 'registries'/
  );
});

test('stage refuses an npm override that pnpm-workspace.yaml does not repeat', () => {
  const pkg = JSON.parse(CHECKOUT['a/package.json']);
  pkg.overrides = { ms: '2.1.3' };
  const dir = scratch({ checkout: { 'a/package.json': JSON.stringify(pkg) } });
  refused(
    dir,
    ['stage', path.join(dir, 'checkout'), path.join(dir, 'i'), path.join(dir, 'f')],
    /pnpm ignores npm's overrides/
  );
});

test('imports accepts the imported lockfiles and refuses one carrying catalogs', () => {
  const ok = scratch();
  const r = convert(ok, 'imports', path.join(ok, 'checkout'), path.join(ok, 'imports'));
  assert.equal(r.status, 0, r.out);

  const bad = scratch({
    imports: {
      'a/pnpm-lock.yaml': `catalogs:\n  default:\n    ms: 2.1.3\n\n${IMPORTED['a/pnpm-lock.yaml']}`,
    },
  });
  refused(
    bad,
    ['imports', path.join(bad, 'checkout'), path.join(bad, 'imports')],
    /top-level section\(s\) \['catalogs'\]/
  );
});

test('compare accepts the real conversion (control case)', () => {
  const dir = scratch();
  const r = convert(dir, ...compare(dir));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /3 lockfiles/);
});

test('compare refuses a direct dependency whose version moved', () => {
  const moved = FINAL['a/pnpm-lock.yaml']
    .replace('version: 2.1.3', 'version: 2.1.4')
    .replace('ms@2.1.3', 'ms@2.1.4');
  assert.notEqual(moved, FINAL['a/pnpm-lock.yaml']);
  const dir = scratch({ final: { 'a/pnpm-lock.yaml': moved } });
  refused(dir, compare(dir), /ms is 2\.1\.3 in package-lock\.json but 2\.1\.4/);
});

test('compare refuses a package the directory never locked, even at a version another directory locked', () => {
  const crossed = FINAL['b/pnpm-lock.yaml'].replace('packages:\n\n', `packages:\n\n${MS_FROM_A}\n`);
  const dir = scratch({ final: { 'b/pnpm-lock.yaml': crossed } });
  refused(
    dir,
    compare(dir),
    /b: pnpm resolved ms@2\.1\.3, which this package's package-lock\.json did not lock/
  );
});

test('compare refuses a directory whose lockfile was never generated', () => {
  const dir = scratch({ final: { 'b/pnpm-lock.yaml': null } });
  refused(dir, compare(dir), /b: no pnpm-lock\.yaml was generated/);
});

test('compare refuses a workspace link that pnpm turned into a registry version', () => {
  const unlinked = FINAL['b/pnpm-lock.yaml']
    .replace('specifier: workspace:*', 'specifier: 1.0.0')
    .replace('version: link:../a', 'version: 1.0.0');
  const dir = scratch({ final: { 'b/pnpm-lock.yaml': unlinked } });
  refused(dir, compare(dir), /fixture-a is a link in only one/);
});

test('compare refuses a lockfile that gained a direct dependency', () => {
  const extra = FINAL['pnpm-lock.yaml'].replace(
    '  .:\n    devDependencies:',
    '  .:\n    dependencies:\n      isexe:\n        specifier: 4.0.0\n        version: 4.0.0\n    devDependencies:'
  );
  const dir = scratch({ final: { 'pnpm-lock.yaml': extra } });
  refused(dir, compare(dir), /only in pnpm \['isexe'\]/);
});

test('changes accepts exactly the swap and refuses anything else', () => {
  const dir = scratch();
  const swap = ['.', 'a', 'b'].flatMap((d) => {
    const prefix = d === '.' ? '' : `${d}/`;
    return [`?? ${prefix}pnpm-lock.yaml`, ` D ${prefix}package-lock.json`];
  });
  fs.writeFileSync(path.join(dir, 'dirs.txt'), '.\na\nb\n');
  fs.writeFileSync(path.join(dir, 'status.txt'), swap.join('\n') + '\n');
  const ok = convert(dir, 'changes', path.join(dir, 'status.txt'), path.join(dir, 'dirs.txt'));
  assert.equal(ok.status, 0, ok.out);

  fs.writeFileSync(path.join(dir, 'status.txt'), [...swap, ' M package.json'].join('\n') + '\n');
  refused(
    dir,
    ['changes', path.join(dir, 'status.txt'), path.join(dir, 'dirs.txt')],
    /unexpected:  M package\.json/
  );

  fs.writeFileSync(path.join(dir, 'status.txt'), swap.slice(1).join('\n') + '\n');
  refused(
    dir,
    ['changes', path.join(dir, 'status.txt'), path.join(dir, 'dirs.txt')],
    /missing: \?\? pnpm-lock\.yaml/
  );
});

// The commit step's script, up to the line that would call the network.
function commitStepUpToRequest(text) {
  const lines = text.split('\n');
  const name = lines.findIndex(
    (l) => l.trim() === '- name: Commit the lockfile swap via the GitHub API'
  );
  assert.notEqual(name, -1, 'commit step not found');
  const run = lines.findIndex((l, i) => i > name && /^\s*run:\s*\|/.test(l));
  const body = [];
  const indent = lines[run + 1].match(/^ */)[0].length;
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join('\n');
  const cut = script.indexOf('RESPONSE="$(gh api graphql');
  assert.notEqual(cut, -1, 'the gh api graphql call moved; update this test');
  return script.slice(0, cut);
}

test('the commit step builds a request carrying every lockfile byte for byte, deleting every package-lock.json', () => {
  const dir = scratch();
  const runnerTemp = path.join(dir, 'runner');
  fs.mkdirSync(path.join(runnerTemp, 'pnpm-convert'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'program.py'), path.join(runnerTemp, 'pnpm-convert/convert.py'));
  fs.writeFileSync(path.join(runnerTemp, 'pnpm-convert/dirs.txt'), '.\na\nb\n');
  // The workspace after "Apply": the generated lockfiles are in place.
  const work = path.join(dir, 'work');
  write(work, FINAL);
  const git = (...args) => spawnSync('git', args, { cwd: work, encoding: 'utf8' });
  git('init', '-q');
  git(
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x'
  );
  const head = git('rev-parse', 'HEAD').stdout.trim();

  const script = commitStepUpToRequest(fs.readFileSync(WORKFLOW, 'utf8'));
  const r = spawnSync('bash', ['-c', script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_WORKSPACE: work,
      BRANCH: 'topic',
      REPO: 'org/repo',
      GH_TOKEN: 'unused',
    },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const request = JSON.parse(
    fs.readFileSync(path.join(runnerTemp, 'pnpm-convert/request.json'), 'utf8')
  );
  const input = request.variables.input;
  assert.match(request.query, /createCommitOnBranch\(input: \$input\)/);
  assert.equal(input.expectedHeadOid, head);
  assert.deepEqual(input.branch, { repositoryNameWithOwner: 'org/repo', branchName: 'topic' });
  assert.deepEqual(
    input.fileChanges.deletions.map((d) => d.path),
    ['package-lock.json', 'a/package-lock.json', 'b/package-lock.json']
  );
  for (const added of input.fileChanges.additions) {
    assert.equal(Buffer.from(added.contents, 'base64').toString('utf8'), FINAL[added.path]);
  }
  assert.deepEqual(
    input.fileChanges.additions.map((a) => a.path),
    ['pnpm-lock.yaml', 'a/pnpm-lock.yaml', 'b/pnpm-lock.yaml']
  );
});
