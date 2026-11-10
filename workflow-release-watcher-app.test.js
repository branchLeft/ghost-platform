// Pins the identity and token handling of release-watcher-run.yml: the digest
// PR is opened by a GitHub App whose short-lived installation token is minted
// at run time, with nothing long-lived stored. Reads the workflow text; no
// YAML parser, so the file stays dependency-free like its siblings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(import.meta.dirname, '.github', 'workflows', 'release-watcher-run.yml');

const MINT_ACTION = 'actions/create-github-app-token';
// Pinned by commit sha; the trailing comment names the release the sha was
// verified against (the release is more than two weeks old).
const MINT_USES = /uses:\s*actions\/create-github-app-token@([0-9a-f]{40})\s+#\s+v\d+\.\d+\.\d+\s*$/m;

function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

export function readWorkflow() {
  return stripCommentLines(fs.readFileSync(WORKFLOW, 'utf8'));
}

// One entry per `- name:` step, with its full text.
export function steps(text) {
  const starts = [...text.matchAll(/^[ \t]*- name:/gm)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const body = text.slice(m.index, end);
    return { name: /- name:\s*(.*)/.exec(body)[1].trim(), body };
  });
}

function mintStep(text) {
  const found = steps(text).filter((s) => s.body.includes(MINT_ACTION));
  assert.equal(found.length, 1, 'exactly one step mints the installation token');
  return found[0];
}

function topLevelPermissions(text) {
  const m = /^permissions:\n((?:[ ]{2}\S.*\n)+)/m.exec(text);
  assert.ok(m, 'a top-level permissions block exists');
  return m[1]
    .split('\n')
    .filter(Boolean)
    .map((l) => l.trim());
}

test('the token is minted by create-github-app-token pinned to a commit sha with a version comment', () => {
  const step = mintStep(readWorkflow());
  assert.match(step.body, MINT_USES);
});

test('the pinned sha is the one verified against the v3.3.0 release', () => {
  const step = mintStep(readWorkflow());
  assert.equal(MINT_USES.exec(step.body)[1], '64ab729a6294000f5aa4a4bc0b73d1f32bc45510');
  assert.match(step.body, /# v3\.3\.0/);
});

test('the mint step reads the App id from a variable and the key from a secret', () => {
  const step = mintStep(readWorkflow());
  assert.match(step.body, /app-id:\s*\$\{\{\s*vars\.DIGEST_APP_ID\s*\}\}/);
  assert.match(step.body, /private-key:\s*\$\{\{\s*secrets\.DIGEST_APP_PRIVATE_KEY\s*\}\}/);
});

test('the minted token asks for checks read, contents write and pull-requests write and nothing else', () => {
  const step = mintStep(readWorkflow());
  const asked = [...step.body.matchAll(/^\s+(permission-[a-z-]+):\s*(\S+)\s*$/gm)].map(
    (m) => `${m[1]}=${m[2]}`
  );
  assert.deepEqual(asked.sort(), [
    'permission-checks=read',
    'permission-contents=write',
    'permission-pull-requests=write',
  ]);
});

test('the token is scoped to this repository: no owner and no repositories input', () => {
  const step = mintStep(readWorkflow());
  assert.doesNotMatch(step.body, /^\s+owner:/m);
  assert.doesNotMatch(step.body, /^\s+repositories:/m);
});

test('the key is read by the mint step alone, and a secret or the token appears only as a mapping value', () => {
  const text = readWorkflow();
  for (const s of steps(text)) {
    if (s.body.includes(MINT_ACTION)) continue;
    assert.doesNotMatch(s.body, /DIGEST_APP_PRIVATE_KEY/, `step "${s.name}" must not read the key`);
  }
  // Never inside script text: each line naming a secret or the minted token is
  // a `KEY: ${{ ... }}` mapping value, so nothing can echo it.
  for (const line of text.split('\n')) {
    if (!/secrets\.|outputs\.token/.test(line)) continue;
    assert.match(line, /^\s+[A-Za-z_-]+:\s*\$\{\{[^}]*\}\}\s*$/, `not a mapping value: ${line}`);
  }
});

test('no static token: RELEASE_WATCHER_TOKEN is never read from secrets, and no personal token is used', () => {
  const text = readWorkflow();
  assert.doesNotMatch(text, /secrets\.RELEASE_WATCHER_TOKEN/);
  assert.doesNotMatch(text, /secrets\.(?!DIGEST_APP_PRIVATE_KEY\b)\w+/);
  assert.doesNotMatch(text, /\bPAT\b|personal[-_ ]access/i);
});

test('the watcher step receives the minted token through its environment', () => {
  const text = readWorkflow();
  const watcher = steps(text).find((s) => /release_watcher\.cli/.test(s.body));
  assert.ok(watcher, 'the watcher step exists');
  assert.match(
    watcher.body,
    /RELEASE_WATCHER_TOKEN:\s*\$\{\{\s*steps\.app-token\.outputs\.token\s*\}\}/
  );
  assert.match(mintStep(text).body, /id:\s*app-token/);
});

test('the mint step runs before the watcher and only once the App id variable is set', () => {
  const text = readWorkflow();
  const all = steps(text);
  const mint = all.findIndex((s) => s.body.includes(MINT_ACTION));
  const watcher = all.findIndex((s) => /release_watcher\.cli/.test(s.body));
  assert.ok(mint !== -1 && watcher !== -1 && mint < watcher);
  assert.match(all[mint].body, /if:\s*\$\{\{\s*vars\.DIGEST_APP_ID\s*!=\s*''\s*\}\}/);
});

test('the workflow permissions block is contents: write and nothing broader', () => {
  const text = readWorkflow();
  assert.deepEqual(topLevelPermissions(text), ['contents: write']);
  assert.doesNotMatch(text, /write-all|permissions:\s*\{\s*\}\s*\n\s*jobs/);
  assert.doesNotMatch(text, /^\s{4,}permissions:/m);
});

test('the matcher refuses a workflow that mints with an unpinned ref or an extra permission', () => {
  assert.doesNotMatch('uses: actions/create-github-app-token@v3 # v3.3.0\n', MINT_USES);
  assert.doesNotMatch('uses: actions/create-github-app-token@' + 'a'.repeat(40) + '\n', MINT_USES);
  assert.match(
    'uses: actions/create-github-app-token@' + 'a'.repeat(40) + ' # v3.3.0\n',
    MINT_USES
  );
});

// ---- the merge of the digest PR ----

const WATCHER_DIR = path.join(import.meta.dirname, 'services', 'release-watcher', 'release_watcher');
const MERGE_SRC = path.join(WATCHER_DIR, 'merge.py');
const CLIENTS_SRC = path.join(WATCHER_DIR, 'clients.py');

function mergeStep(text) {
  const found = steps(text).filter((s) => /release_watcher\.merge/.test(s.body));
  assert.equal(found.length, 1, 'exactly one step runs the merge');
  return found[0];
}

function pythonBody(file) {
  return stripCommentLines(fs.readFileSync(file, 'utf8'));
}

// The text of `def name(` up to the next def, so an order assertion reads one
// function, not the whole module.
function functionText(src, name) {
  const start = src.indexOf(`def ${name}(`);
  assert.notEqual(start, -1, `def ${name} exists`);
  const next = src.slice(start + 1).search(/^(?:def|class) /m);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

test('the merge step runs after the watcher and before the gauge is committed', () => {
  const all = steps(readWorkflow());
  const watcher = all.findIndex((s) => /release_watcher\.cli/.test(s.body));
  const merge = all.findIndex((s) => /release_watcher\.merge/.test(s.body));
  const gauge = all.findIndex((s) => /release-watcher: record poll/.test(s.body));
  assert.ok(watcher !== -1 && merge !== -1 && gauge !== -1);
  assert.ok(watcher < merge && merge < gauge);
});

test('the merge step runs only with a minted token and gets the App identity from variables', () => {
  const step = mergeStep(readWorkflow());
  assert.match(step.body, /if:\s*\$\{\{\s*steps\.app-token\.outputs\.token\s*!=\s*''\s*\}\}/);
  assert.match(step.body, /RELEASE_WATCHER_TOKEN:\s*\$\{\{\s*steps\.app-token\.outputs\.token\s*\}\}/);
  assert.match(step.body, /DIGEST_MACHINE_SLUG:\s*\$\{\{\s*vars\.DIGEST_MACHINE_SLUG\s*\}\}/);
  assert.match(step.body, /DIGEST_MACHINE_LOGIN:\s*\$\{\{\s*vars\.DIGEST_MACHINE_LOGIN\s*\}\}/);
  assert.match(step.body, /MINTED_APP_SLUG:\s*\$\{\{\s*steps\.app-token\.outputs\.app-slug\s*\}\}/);
});

test('the job timeout covers the merge wait', () => {
  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(readWorkflow())[1]);
  const wait = Number(/^TIMEOUT_SECONDS\s*=\s*(\d+)/m.exec(pythonBody(MERGE_SRC))[1]);
  assert.ok(timeout * 60 > wait + 600, 'the job outlives the poll with room for the rest');
});

test('no admin, bypass or auto-merge anywhere in the workflow or the merge code', () => {
  const forbidden = /--admin|--auto\b|allow_auto_merge|enable_auto_merge|enablePullRequestAutoMerge|autoMerge|bypass/i;
  for (const [label, body] of [
    ['workflow', readWorkflow()],
    ['merge.py', pythonBody(MERGE_SRC)],
    ['clients.py', pythonBody(CLIENTS_SRC)],
  ]) {
    assert.doesNotMatch(body, forbidden, `${label} must not use ${forbidden}`);
    assert.doesNotMatch(body, /gh\s+pr\s+merge/, `${label} must not shell out to the gh merge command`);
  }
});

test('the only merge method is squash and the merge is pinned to the checked head sha', () => {
  const clients = pythonBody(CLIENTS_SRC);
  const call = functionText(clients, 'merge_pull');
  assert.match(call, /"merge_method":\s*"squash"/);
  assert.match(call, /"sha":\s*sha/);
  assert.doesNotMatch(call, /"merge_method":\s*"(?!squash)/);
  assert.match(call, /def merge_pull\(self, number, sha\):/);
});

test('run() applies the identity, author, line-only and check gates before it calls merge_pull', () => {
  const body = functionText(pythonBody(MERGE_SRC), 'run');
  const order = [
    'expected_author(env)',
    'is_authored_by(pull, login)',
    'verify_digest_only(',
    'LINE_SCOPE_CHECK not in required',
    'wait_for_checks(',
    'github.merge_pull(',
  ].map((needle) => {
    const at = body.indexOf(needle);
    assert.notEqual(at, -1, `run() contains ${needle}`);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(body.split('github.merge_pull(').length - 1, 1, 'one merge call');
});

test('the author gate needs the exact App bot login, and the line-scope check must be a plain success', () => {
  const src = pythonBody(MERGE_SRC);
  assert.match(functionText(src, 'expected_author'), /login = f"\{slug\}\[bot\]"/);
  assert.match(functionText(src, 'is_authored_by'), /user\.get\("type"\) == "Bot"/);
  assert.match(functionText(src, 'assess_checks'), /name == LINE_SCOPE_CHECK else PASSING/);
  assert.match(src, /LINE_SCOPE_CHECK = "Digest-only line scope"/);
});

test('a merge failure is an error annotation and a failing exit, never swallowed', () => {
  const body = functionText(pythonBody(MERGE_SRC), 'main');
  assert.match(body, /except \(Refused, RuntimeError\) as failure:[\s\S]*::error::[\s\S]*return 1/);
  assert.doesNotMatch(readWorkflow(), /continue-on-error/);
  assert.doesNotMatch(readWorkflow(), /\|\|\s*true/);
});
