// Gate: the standing content-policy regression (LLD-5 05-gate-and-edge.html
// C1, "only true for the versions it was measured on"). A real headless
// browser loads the site through the edge with a hostile codeinjection_head;
// this module is the verdict on what it observed. Observation lives in
// csp/proof/capture-csp.mjs; the live runner is csp-regression-gate.sh.
//
// Standalone check: the slot 0 gate-set runner
// has no code yet.

import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `run` is capture-csp.mjs's JSON. Returns failure strings; empty = holds.
 * Holds only when: the injected script did not run, Portal's sign-in form
 * rendered with its email field, and the sole violation is the attack
 * (an inline script blocked by script-src).
 */
export function judgeRegression(run) {
  const failures = [];
  if (run.injectedScriptRan !== false) {
    failures.push('the injected script ran');
  }
  if (run.portalSignInForm !== 'rendered' || !(run.emailFields >= 1)) {
    failures.push("Portal's sign-in form did not render");
  }
  const violations = Array.isArray(run.cspViolations) ? run.cspViolations : [];
  // Exactly the attack's signature: an inline script refused by script-src-elem.
  // Any other directive or blocked URI is some other violation, never the attack.
  const isAttack = (v) => v.directive === 'script-src-elem' && v.blockedURI === 'inline';
  if (violations.length !== 1 || !isAttack(violations[0])) {
    failures.push(
      `expected exactly one violation, the attack; got ${violations.length}: ${JSON.stringify(violations)}` +
        (violations.length > 1 ? " (Ghost's own inline blocks are blocked too)" : '')
    );
  }
  return failures;
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const run = JSON.parse(readFileSync(0, 'utf-8'));
  const failures = judgeRegression(run);
  for (const f of failures) console.error(`CSP REGRESSION GATE RED: ${f}`);
  if (failures.length === 0) console.log('CSP REGRESSION GATE GREEN');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// String equality against `file://${argv[1]}` misses when the path has a space
// or non-ASCII (import.meta.url is percent-encoded) or when argv[1] is a
// symlink. Compare real filesystem paths so a launch of this file is judged.
const SELF = fileURLToPath(import.meta.url);

// 'main': this file was launched directly. 'misfire': argv[1] names this file
// (same basename) but does not resolve to it, so the guard cannot tell whether
// the capture is ours to judge. 'imported': some other module loaded us.
function classifyEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return 'imported';
  let resolved = null;
  try {
    resolved = realpathSync(argv1);
  } catch {
    resolved = null;
  }
  if (resolved !== null && resolved === realpathSync(SELF)) return 'main';
  return basename(argv1) === basename(SELF) ? 'misfire' : 'imported';
}

// Fail closed on a misfire: a piped capture that nobody judged must not exit 0.
// A TTY carries no capture, so it is not read (reading it would block).
function failClosedOnMisfire() {
  if (process.stdin.isTTY) return;
  const captured = readFileSync(0, 'utf-8');
  if (captured.length === 0) return;
  console.error(
    'CSP REGRESSION GATE RED: run-as-main guard did not match; capture not judged'
  );
  process.exitCode = 1;
}

const entry = classifyEntry();
if (entry === 'main') {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
} else if (entry === 'misfire') {
  failClosedOnMisfire();
}
