// Gate: the standing content-policy regression (LLD-5 05-gate-and-edge.html
// C1, "only true for the versions it was measured on"). A real headless
// browser loads the site through the edge with a hostile codeinjection_head;
// this module is the verdict on what it observed. Observation lives in
// csp/proof/capture-csp.mjs; the live runner is csp-regression-gate.sh.
//
// Standalone check (branchLeft/workspace#1251): the slot 0 gate-set runner
// (branchLeft/workspace#1188) has no code yet.

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
