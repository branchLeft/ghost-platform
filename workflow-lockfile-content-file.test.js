// Linux caps a single argv or env string at 128 KiB (MAX_ARG_STRLEN); a
// real lockfile's base64 form clears that today (services/mailgun-shim's
// does). This runs generate-lockfile.yml's own "Commit the lockfile"
// step -- extracted from the live YAML, not reimplemented -- against a
// generated lockfile well over that cap, and proves the resulting GraphQL
// request round-trips the content exactly. A `base64` shim on PATH covers
// this machine's BSD `base64`, which has no `-w0` flag; GNU `base64` on
// the real runner accepts the workflow's own invocation unshimmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKFLOW_PATH = path.join(
  import.meta.dirname,
  '.github',
  'workflows',
  'generate-lockfile.yml'
);
const STEP_NAME = 'Commit the lockfile via the GitHub API, if it changed';
const REQUEST_MARKER = 'RESPONSE="$(gh api graphql --input';

// Extracts one step's `run: |` block by name, dedented to column 0 --
// the same shape `node --test` would see if the step were its own file.
function extractStepRun(text, stepName) {
  const lines = text.split('\n');
  const nameIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notEqual(nameIdx, -1, `step not found: ${stepName}`);

  let runIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i++) {
    if (i !== nameIdx && /^\s*- name:/.test(lines[i])) break;
    if (/^\s*run:\s*\|/.test(lines[i])) {
      runIdx = i;
      break;
    }
  }
  assert.notEqual(runIdx, -1, `no 'run: |' block found for step: ${stepName}`);

  const body = [];
  let baseIndent = null;
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;
    body.push(line.slice(baseIndent));
  }
  return body.join('\n');
}

// Stops the extracted script just before the one line that would make a
// real network call, so this test proves the request-building half --
// exactly the half the 128 KiB cap threatens -- without needing live
// GitHub credentials. If a workflow edit removes this line entirely (for
// example, reverting to the old argv-based `-f content=...` call), this
// throws here rather than silently testing nothing.
function upToRequestBuild(script) {
  const idx = script.indexOf(REQUEST_MARKER);
  assert.notEqual(
    idx,
    -1,
    `expected to find ${JSON.stringify(REQUEST_MARKER)} in the extracted step`
  );
  return script.slice(0, idx);
}

function writeBase64Shim(dir) {
  // GNU base64 (the real runner) accepts the workflow's own `-w0 FILE`
  // unmodified -- passed straight through. BSD base64 (this machine) has
  // no wrap flag (never wraps by default) and takes an input file only via
  // -i, never positionally, so only that branch needs translating.
  const shim = `#!/bin/bash
if /usr/bin/base64 --version 2>&1 | grep -q GNU; then
  exec /usr/bin/base64 "$@"
fi
opts=()
file=""
for a in "$@"; do
  case "$a" in
    -w0|--wrap=0) continue ;;
    -*) opts+=("$a") ;;
    *) file="$a" ;;
  esac
done
if [ -n "$file" ]; then
  exec /usr/bin/base64 "\${opts[@]}" -i "$file"
else
  exec /usr/bin/base64 "\${opts[@]}"
fi
`;
  const shimPath = path.join(dir, 'base64');
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });
}

function initRepoWithFile(repoDir, relPath, initialContent) {
  fs.mkdirSync(path.dirname(path.join(repoDir, relPath)), { recursive: true });
  fs.writeFileSync(path.join(repoDir, relPath), initialContent);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return git('rev-parse', 'HEAD').trim();
}

test('the commit step builds a large lockfile request without argv/env, and round-trips it exactly', () => {
  const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const script = upToRequestBuild(extractStepRun(workflowText, STEP_NAME));

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-repo-'));
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-shim-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-runnertemp-'));
  try {
    writeBase64Shim(shimDir);
    initRepoWithFile(repoDir, 'services/big/package-lock.json', '{"name":"placeholder"}\n');

    // 150,000 raw bytes base64-encodes to 200,000 bytes -- comfortably
    // over the 131,072-byte argv/env cap the old `-f content=...` call
    // would have hit, and bigger than any lockfile in this repo today.
    const large = JSON.stringify({ packages: { x: 'y'.repeat(150000) } });
    fs.writeFileSync(path.join(repoDir, 'services/big/package-lock.json'), large);

    const result = spawnSync('bash', ['-c', script], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        PATH: `${shimDir}:${process.env.PATH}`,
        PACKAGE_DIR: 'services/big',
        BRANCH: 'test-branch',
        GH_TOKEN: 'unused-in-this-truncated-script',
        REPO: 'test-org/test-repo',
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: path.join(runnerTemp, 'github-output'),
        HOME: process.env.HOME,
      },
    });

    assert.equal(
      result.status,
      0,
      `commit-building step failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    const requestFile = path.join(runnerTemp, 'create-commit-request.json');
    assert.ok(fs.existsSync(requestFile), 'create-commit-request.json was not written');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));

    assert.match(request.query, /createCommitOnBranch/);
    assert.equal(request.variables.path, 'services/big/package-lock.json');

    const contentB64 = request.variables.content;
    assert.ok(
      Buffer.byteLength(contentB64, 'utf8') > 131072,
      `test content (${Buffer.byteLength(contentB64, 'utf8')} bytes) does not actually exceed the 128 KiB argv/env cap`
    );
    const decoded = Buffer.from(contentB64, 'base64');
    assert.deepEqual(
      decoded,
      Buffer.from(large),
      'decoded request content does not match the original lockfile bytes'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test('the extractor finds the named step and stops before the network call', () => {
  const sample = `
jobs:
  generate:
    steps:
      - name: Commit the lockfile via the GitHub API, if it changed
        run: |
          echo one
          RESPONSE="$(gh api graphql --input "$REQUEST_FILE")"
          echo two
      - name: Next step
        run: |
          echo unrelated
`;
  const full = extractStepRun(sample, STEP_NAME);
  assert.match(full, /echo one/);
  assert.match(full, /echo two/);
  assert.doesNotMatch(full, /echo unrelated/);

  const truncated = upToRequestBuild(full);
  assert.match(truncated, /echo one/);
  assert.doesNotMatch(truncated, /echo two/);
});
