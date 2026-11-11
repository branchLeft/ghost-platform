// Sabotage proof for the gate set. Each case breaks one control in the real
// source, requires the tests to go red, restores the file, and requires them
// green. A case whose target text is not found aborts: a sabotage that changed
// nothing proves nothing. Per gate: the gate's verdict forced green. Then the
// runner's and the attestation verdict's own rules. Exits 1 on any case the
// tests did not catch. No Docker needed. Usage: node gate-set/prove-sabotage.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const TESTS = ['gate-set.test.mjs', 'gates.test.mjs'].map((file) => path.join(HERE, file));

// [label, file, text that must be there, what replaces it]
export const CASES = [
  // The six gates: each one's verdict forced green.
  [
    'overlay-check/drift-ignored',
    'gates.mjs',
    "return { ok: problems.length === 0, detail: problems.join('; ') };",
    "return { ok: true, detail: problems.join('; ') };",
  ],
  [
    'overlay-check/bytes-not-compared',
    'gates.mjs',
    'else if (found !== overlay.expected)',
    'else if (false)',
  ],
  [
    'overlay-check/sha256sum-failure-ignored',
    'gates.mjs',
    'if (overlayRun.code !== 0) {',
    'if (false) {',
  ],
  ['smoke/exit-ignored', 'gates.mjs', 'ok: smokeRun.code === 0', 'ok: true'],
  [
    'storage/guard-test-ignored',
    'gates.mjs',
    'ok: storageRun.code === 0 && guardRun.code === 0',
    'ok: storageRun.code === 0',
  ],
  [
    'storage/image-tests-ignored',
    'gates.mjs',
    'ok: storageRun.code === 0 && guardRun.code === 0',
    'ok: guardRun.code === 0',
  ],
  ['theme-scan/exit-ignored', 'gates.mjs', 'ok: themeRun.code === 0', 'ok: true'],
  ['mail/exit-ignored', 'gates.mjs', 'ok: mailRun.code === 0', 'ok: true'],
  ['content-policy/exit-ignored', 'gates.mjs', 'ok: policyRun.code === 0', 'ok: true'],
  // The runner: a candidate is refused unless every gate said true.
  [
    'runner/truthy-passes',
    'gate-set.mjs',
    'ok = outcome?.ok === true;',
    'ok = Boolean(outcome?.ok);',
  ],
  [
    'runner/throw-passes',
    'gate-set.mjs',
    '} catch (error) {\n      detail =',
    '} catch (error) {\n      ok = true;\n      detail =',
  ],
  [
    'runner/unwired-gate-passes',
    'gate-set.mjs',
    "ok: false, durationMs: 0, detail: 'gate is not wired'",
    "ok: true, durationMs: 0, detail: 'gate is not wired'",
  ],
  [
    'runner/summary-always-green',
    'gate-set.mjs',
    'ok: results.every((result) => result.ok === true),',
    'ok: true,',
  ],
  ['runner/exit-code-always-0', 'gate-set.mjs', 'return report.ok ? 0 : 1;', 'return 0;'],
  // The attestation's verdict on a record.
  ['verify/digest-not-compared', 'gate-set.mjs', 'if (report.digest !== digest) {', 'if (false) {'],
  ['verify/missing-gate-accepted', 'gate-set.mjs', '.length !== 1', '.length === 99'],
  [
    'verify/red-result-accepted',
    'gate-set.mjs',
    'filter((result) => result?.ok !== true)',
    "filter((result) => result?.ok === 'never')",
  ],
  ['verify/exit-code-always-0', 'gate-set.mjs', 'return verdict.ok ? 0 : 1;', 'return 0;'],
  ['dockerfile/unpinned-from-accepted', 'gate-set.mjs', 'if (!digest) {', 'if (false) {'],
];

const testsGreen = () => spawnSync('node', ['--test', ...TESTS], { stdio: 'ignore' }).status === 0;

function prove() {
  let failed = false;
  if (!testsGreen()) {
    console.log('BASELINE: RED');
    return 1;
  }
  console.log('BASELINE: GREEN');
  for (const [label, file, from, to] of CASES) {
    const target = path.join(HERE, file);
    const original = fs.readFileSync(target, 'utf8');
    if (!original.includes(from)) {
      console.log(`SABOTAGE ${label}: TARGET NOT FOUND`);
      return 3;
    }
    try {
      fs.writeFileSync(target, original.replace(from, to));
      if (testsGreen()) {
        console.log(`SABOTAGE ${label}: NOT DETECTED (tests stayed green)`);
        failed = true;
      } else {
        console.log(`SABOTAGE ${label}: RED`);
      }
    } finally {
      fs.writeFileSync(target, original);
    }
    if (testsGreen()) {
      console.log(`RESTORED ${label}: GREEN`);
    } else {
      console.log(`RESTORED ${label}: STILL RED`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(prove());
}
