// Scoped to createCommitOnBranch steps only -- never looks at `git push`,
// so a revert to it would not by itself be caught here (main's
// signed-commit ruleset still refuses that commit at merge). See
// .github/workflows/README-generate-lockfile.md "Why createCommitOnBranch".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');

// Whole-line `#` comments are stripped first (blanked, not removed, so line
// numbers stay stable): a rationale comment that merely *names*
// createCommitOnBranch or verification.verified -- as this guard's own
// header, and generate-lockfile.yml's, both do -- must never be mistaken
// for the executable check it's describing.
function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// Scans step-by-step (from one `- name:` line to the next, or EOF), not the
// whole file: a verified read-back belonging to a different step can't be
// credited to this one. A step that calls createCommitOnBranch must, later
// in that same step, read the new commit's `verification.verified` field,
// compare it to `true`, and `exit 1` somewhere after that comparison.
function stepsMissingVerification(rawText) {
  const text = stripCommentLines(rawText);
  const stepStarts = [...text.matchAll(/^[ \t]*- name:/gm)];
  const offenders = [];
  for (let i = 0; i < stepStarts.length; i++) {
    const start = stepStarts[i].index;
    const end = i + 1 < stepStarts.length ? stepStarts[i + 1].index : text.length;
    const step = text.slice(start, end);
    if (!/createCommitOnBranch/.test(step)) continue;
    const readsVerified = /verification\.verified/.test(step);
    const comparison = step.match(/!=\s*["']?true["']?/);
    const failsClosed = Boolean(comparison) && /exit\s+1/.test(step.slice(comparison.index));
    if (!readsVerified || !failsClosed) {
      offenders.push(text.slice(0, start).split('\n').length);
    }
  }
  return offenders;
}

test('every createCommitOnBranch step reads verification.verified and fails closed', () => {
  const offenders = [];
  for (const name of fs.readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    for (const line of stepsMissingVerification(text)) offenders.push(`${name}:${line}`);
  }
  assert.deepEqual(offenders, []);
});

test('the matcher flags a missing or non-failing read-back, and clears a real one', () => {
  const missing = `
- name: Commit
  run: |
    gh api graphql -f query="mutation { createCommitOnBranch(input: {}) { commit { oid } } }"
`;
  assert.deepEqual(stepsMissingVerification(missing), [2]);

  const readsButNeverFails = `
- name: Commit
  run: |
    gh api graphql -f query="mutation { createCommitOnBranch(input: {}) { commit { oid } } }"
    echo "$VERIFICATION" | jq -r '.commit.verification.verified'
`;
  assert.deepEqual(stepsMissingVerification(readsButNeverFails), [2]);

  const ok = `
- name: Commit
  run: |
    gh api graphql -f query="mutation { createCommitOnBranch(input: {}) { commit { oid } } }"
    VERIFIED="$(printf '%s' "$VERIFICATION" | jq -r '.commit.verification.verified')"
    if [ "$VERIFIED" != "true" ]; then
      exit 1
    fi
`;
  assert.deepEqual(stepsMissingVerification(ok), []);
});
