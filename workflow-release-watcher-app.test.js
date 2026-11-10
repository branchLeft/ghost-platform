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

test('the minted token asks for contents and pull-requests write and nothing else', () => {
  const step = mintStep(readWorkflow());
  const asked = [...step.body.matchAll(/^\s+(permission-[a-z-]+):\s*(\S+)\s*$/gm)].map(
    (m) => `${m[1]}=${m[2]}`
  );
  assert.deepEqual(asked.sort(), ['permission-contents=write', 'permission-pull-requests=write']);
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
