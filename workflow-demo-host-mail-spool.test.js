import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The mail spool proof pulls the spool image, a private GHCR package, inside a
// Docker-in-Docker stand-in. Three things keep that pull honest: the workflow
// grants the run token the read scope and nothing wider, the token reaches the
// script only through the environment and goes to `docker login` on stdin, and
// a refused login or pull stops the run. Each case breaks one of them in a copy
// of the real text and requires a named problem.
const ROOT = import.meta.dirname;
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'demo-host-mail-spool-ci.yml'),
  'utf8'
);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'test-demo-mail-spool.sh'), 'utf8');

const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};
const uncommented = (text) => text.replace(/^\s*#.*$/gm, '');

function workflowProblems(source) {
  const found = [];
  const text = uncommented(source);
  const top = text.split(/^jobs:\n/m)[0];
  if (!/^permissions:\n {2}contents: read\n {2}packages: read\n(?! {2}\S)/m.test(top)) {
    found.push('top-level permissions are not exactly contents: read and packages: read');
  }
  if (/^\s*packages: write/m.test(text)) found.push('the workflow grants packages: write');
  const steps = text.split(/^(?=      - name: )/m).filter((s) => s.startsWith('      - name: '));
  const runs = steps.filter((s) => /\.\/scripts\/test-demo-mail-spool\.sh/.test(s));
  if (
    runs.length < 4 ||
    !steps.some((s) => /run: .\/scripts\/test-demo-mail-spool\.sh\n/.test(s))
  ) {
    found.push('the proof, sabotage and refusal steps are not all present');
  }
  for (const step of runs) {
    const env = step.match(/^ {8}env:\n((?: {10}.*\n)+)/m)?.[1] ?? '';
    if (!/GHCR_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}|GHCR_TOKEN: ''/.test(env)) {
      found.push(`a script step reads its token from somewhere other than the run token`);
    }
  }
  if (!steps.some((s) => /GHCR_USER: \$\{\{ github\.actor \}\}/.test(s))) {
    found.push('no step passes the actor as the registry user');
  }
  if (/secrets\.(?!GITHUB_TOKEN\b)/.test(text)) found.push('the workflow reads another secret');
  if (/\bset -x\b|echo[^\n]*GHCR_TOKEN/.test(text)) found.push('the workflow can print the token');
  const refused = steps.find((s) => /could not pull/.test(s));
  if (!refused || !/SPOOL_IMAGE: ghcr\.io\/branchleft\/mailgun-shim@sha256:0{64}/.test(refused)) {
    found.push('no sabotage step proves a refused pull stops the run');
  }
  const missing = steps.find((s) => /set GHCR_USER and GHCR_TOKEN/.test(s));
  if (!missing || !/GHCR_TOKEN: ''/.test(missing)) {
    found.push('no sabotage step proves a missing credential refuses to start');
  }
  return found;
}

function scriptProblems(source) {
  const found = [];
  const text = uncommented(source);
  if (!/docker login ghcr\.io -u "\$GHCR_USER" --password-stdin/.test(text)) {
    found.push('the script does not log in with the token on stdin');
  }
  if (/docker login[^\n]*( -p|--password)[ =]/.test(text.replace(/--password-stdin/g, ''))) {
    found.push('the script passes a password as an argument');
  }
  if (/echo[^\n]*\$GHCR_TOKEN|set -x|>[^\n]*\$GHCR_TOKEN/.test(text)) {
    found.push('the script can print or store the token');
  }
  if (
    !/if ! on_host "docker pull -q \$SPOOL_IMAGE"[^\n]*; then\n[^\n]*FAIL[^\n]*\n[^\n]*\n\s+exit 1\n/.test(
      text
    )
  ) {
    found.push('a refused pull does not stop the script with a FAIL line');
  }
  if (!/set GHCR_USER and GHCR_TOKEN[^\n]*exit 1/.test(text)) {
    found.push('a missing credential does not stop the script');
  }
  if (text.indexOf('docker login ghcr.io') > text.indexOf('docker pull -q $SPOOL_IMAGE')) {
    found.push('the script pulls before it logs in');
  }
  if (!/docker logout ghcr\.io/.test(text)) found.push('the script never logs out');
  return found;
}

const has = (list, expected) => list.some((p) => p.includes(expected));

test('the real workflow and script give the stand-in host a read-only, unlogged credential', () => {
  assert.deepEqual(workflowProblems(WORKFLOW), []);
  assert.deepEqual(scriptProblems(SCRIPT), []);
});

test('the workflow checker reports each way the credential path can go wrong', () => {
  const cases = [
    [swap(WORKFLOW, '  packages: read\n', ''), 'top-level permissions'],
    [swap(WORKFLOW, '  packages: read\n', '  packages: write\n'), 'top-level permissions'],
    [
      swap(WORKFLOW, 'GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GHCR_TOKEN: ${{ secrets.PAT }}'),
      'reads another secret',
    ],
    [WORKFLOW.replaceAll('GHCR_USER: ${{ github.actor }}', 'GHCR_USER: someone'), 'actor'],
    [swap(WORKFLOW, 'run: ./scripts/test-demo-mail-spool.sh\n', 'run: true\n'), 'not all present'],
    [
      swap(
        WORKFLOW,
        '        run: ./scripts/test-demo-mail-spool.sh\n',
        '        run: |\n          set -x\n          ./scripts/test-demo-mail-spool.sh\n'
      ),
      'print the token',
    ],
    [swap(WORKFLOW, 'could not pull', 'xx'), 'refused pull'],
    [swap(WORKFLOW, 'set GHCR_USER and GHCR_TOKEN', 'xx'), 'missing credential'],
  ];
  for (const [text, expected] of cases) {
    const found = workflowProblems(text);
    assert.ok(has(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('the script checker reports each way the credential path can go wrong', () => {
  const cases = [
    [swap(SCRIPT, ' --password-stdin', ''), 'on stdin'],
    [
      swap(SCRIPT, '-u "$GHCR_USER" --password-stdin', '-u "$GHCR_USER" -p "$GHCR_TOKEN"'),
      'on stdin',
    ],
    [swap(SCRIPT, '    exit 1\nfi\n# The credential', 'fi\n# The credential'), 'refused pull'],
    [swap(SCRIPT, 'set GHCR_USER and GHCR_TOKEN', 'xx'), 'missing credential'],
    [swap(SCRIPT, 'docker logout ghcr.io', 'true'), 'never logs out'],
    [`${SCRIPT}\necho "$GHCR_TOKEN"\n`, 'print or store'],
  ];
  for (const [text, expected] of cases) {
    const found = scriptProblems(text);
    assert.ok(has(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});
