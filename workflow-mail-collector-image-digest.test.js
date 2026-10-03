// Guards .github/workflows/mail-collector-image.yml. The workflow's job is to
// leave a digest-qualified reference for a deployment to pin; every property
// below is one a quiet edit could remove while the workflow still ran green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, '.github', 'workflows', 'mail-collector-image.yml');

function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// A job is the text from its two-space-indented key to the next one.
function jobBlock(text, job) {
  const lines = stripCommentLines(text).split('\n');
  const jobs = lines.findIndex((l) => l === 'jobs:');
  const start = lines.findIndex((l, i) => i > jobs && l === `  ${job}:`);
  if (jobs === -1 || start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function topLevelPermissions(text) {
  const m = stripCommentLines(text).match(/^permissions:\n((?: {2}.*\n)+)/m);
  return m ? m[1] : '';
}

function problems(text) {
  const found = [];
  if (/packages:\s*write/.test(topLevelPermissions(text))) {
    found.push('workflow-level packages: write');
  }
  const body = stripCommentLines(text);
  for (const m of body.matchAll(/uses:\s*(\S+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(m[1])) found.push(`unpinned action ${m[1]}`);
  }
  const push = jobBlock(text, 'push');
  if (!push) {
    found.push('no push job');
    return found;
  }
  if (!/permissions:\n\s+contents: read\n\s+packages: write/.test(push)) {
    found.push('push job does not scope packages: write to itself');
  }
  if (!/needs:\s*test\b/.test(push)) found.push('push job is not gated on tests');
  if (!jobBlock(text, 'test')) found.push('no test job');
  if (!/\bnpm run typecheck\b/.test(body) || !/\bnpm run test:unit\b/.test(body)) {
    found.push('test job does not type check and run the unit tests');
  }
  if (/--tag\s+"?\$IMAGE:latest/.test(push)) found.push('push job tags latest');
  if (
    !/--tag "\$IMAGE:\$IMAGE_TAG"/.test(push) ||
    !/IMAGE_TAG: \$\{\{ github\.sha \}\}/.test(push)
  ) {
    found.push('push job does not tag with the commit SHA');
  }
  const digestStep = push.split(/^\s+- name:/m).find((s) => /id: digest/.test(s)) ?? '';
  if (!/docker inspect[^\n]*RepoDigests/.test(digestStep)) {
    found.push('digest is not read back from the image store');
  }
  if (!/\^sha256:\[0-9a-f\]\{64\}\$/.test(digestStep)) {
    found.push('digest is not matched against a full sha256');
  }
  const check = digestStep.search(/grep -Eq/);
  if (check === -1 || !/exit 1/.test(digestStep.slice(check))) {
    found.push('a malformed digest does not fail the job');
  }
  if (!/image=\$IMAGE@\$digest/.test(digestStep)) {
    found.push('the pinned reference is not image@digest');
  }
  if (!/image: \$\{\{ steps\.digest\.outputs\.image \}\}/.test(push)) {
    found.push('push job does not expose the digest reference as an output');
  }
  return found;
}

test('the real workflow publishes a verified digest-qualified reference', () => {
  assert.deepEqual(problems(fs.readFileSync(FILE, 'utf8')), []);
});

test('the checker flags each regression, so a passing run means something', () => {
  const real = fs.readFileSync(FILE, 'utf8');
  const sabotage = (from, to) => {
    assert.ok(real.includes(from), `fixture anchor missing: ${from}`);
    return real.replace(from, to);
  };

  assert.ok(
    problems(sabotage('    needs: test\n    if: |', '    if: |')).includes(
      'push job is not gated on tests'
    )
  );
  assert.ok(
    problems(
      sabotage(
        'permissions:\n  contents: read\n  packages: read',
        'permissions:\n  contents: read\n  packages: write'
      )
    ).includes('workflow-level packages: write')
  );
  assert.ok(
    problems(
      sabotage('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7')
    ).some((p) => p.startsWith('unpinned action'))
  );
  assert.ok(
    problems(
      sabotage(
        '            exit 1\n          fi\n          echo "image=',
        '            :\n          fi\n          echo "image='
      )
    ).includes('a malformed digest does not fail the job')
  );
  assert.ok(
    problems(sabotage('echo "image=$IMAGE@$digest"', 'echo "image=$IMAGE:$IMAGE_TAG"')).includes(
      'the pinned reference is not image@digest'
    )
  );
  assert.ok(
    problems(sabotage('RepoDigests', 'Id')).includes('digest is not read back from the image store')
  );
});
