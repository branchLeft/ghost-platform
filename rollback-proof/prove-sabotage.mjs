#!/usr/bin/env node
// Proves the proof's own controls can fail. Each case breaks one control in a
// scratch copy of this directory and runs the unit tests there: they must go
// red. The un-broken copy must be green first, or a red means nothing.
//   node rollback-proof/prove-sabotage.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPIED = [
  'contract.mjs',
  'proof.mjs',
  'cli.mjs',
  'warnings.mjs',
  'fake-ops.mjs',
  'contract.test.mjs',
  'proof.test.mjs',
  'cli.test.mjs',
];
const NOOP_CALL = '(() => {})';

/** [name, file, text to find exactly once, text to put in its place] */
export const CASES = [
  [
    'contract: a column the old image uses is gone, ignored',
    'contract.mjs',
    "add(\n          'missing-column',",
    `${NOOP_CALL}(\n          'missing-column',`,
  ],
  [
    'contract: a table the old image uses is gone, ignored',
    'contract.mjs',
    "add(\n        'missing-table',",
    `${NOOP_CALL}(\n        'missing-table',`,
  ],
  [
    'contract: a new required column, ignored',
    'contract.mjs',
    'if (wanted.has(column) || !required(got)) continue;',
    'continue;',
  ],
  [
    'contract: an unknown column is judged without the database before the new image',
    'contract.mjs',
    'if (was.has(column) && required(was.get(column))) continue;',
    '',
  ],
  [
    'contract: a column is judged required without the database before the new image',
    'contract.mjs',
    ' && !required(was.get(column))',
    '',
  ],
  [
    'contract: a column now required, ignored',
    'contract.mjs',
    'required(got) && was.has(column)',
    'false && was.has(column)',
  ],
  [
    'contract: the metadata key is read as a column',
    'contract.mjs',
    "key.startsWith('@@')",
    'false',
  ],
  [
    'proof: findings never turn the schema check red, so never warn',
    'proof.mjs',
    'if (findings.length > 0) {',
    'if (false) {',
  ],
  [
    'proof: a failed check is recorded green',
    'proof.mjs',
    '{ name, ok: false, detail: detailOf(err)',
    '{ name, ok: true, detail: detailOf(err)',
  ],
  [
    'proof: a check that never ran is recorded green',
    'proof.mjs',
    "detail: 'not run'",
    "detail: 'not run', ok: true",
  ],
  [
    'proof: the "new" image is the old one, so nothing is migrated',
    'proof.mjs',
    'await migrateWithNew({ session, newImage, check',
    'await migrateWithNew({ session, newImage: oldImage, check',
  ],
  [
    'proof: the never-published control is dropped',
    'proof.mjs',
    'if (absent.status === 200) {',
    'if (false) {',
  ],
  ['proof: the session is never closed', 'proof.mjs', 'await session.close();', 'void 0;'],
  [
    'proof: the old colour is left running after the smoke set',
    'proof.mjs',
    '  } finally {\n    await colour.remove();\n  }\n}\n\nfunction finalise',
    '  } finally {\n    void 0;\n  }\n}\n\nfunction finalise',
  ],
  [
    'verify: the record is not compared with the pair',
    'proof.mjs',
    'if (record.new?.ref !== newImage)',
    'if (false)',
  ],
  [
    'verify: a run that ended in an error is accepted',
    'proof.mjs',
    'if (record.error !== undefined) reasons.push(',
    'if (false) reasons.push(',
  ],
  [
    'verify: the record is trusted when it says ok',
    'proof.mjs',
    'reasons.push(...found.reasons);',
    'if (record.ok !== true) reasons.push(...found.reasons);',
  ],
  [
    'gate: a candidate whose new image does not boot is only warned about',
    'proof.mjs',
    'else if (GATE_CHECKS.includes(name)) reasons.push(',
    'else if (false) reasons.push(',
  ],
  [
    'half-applied: a rollback check that did not run, with the old image booted, is only a warning',
    'proof.mjs',
    'else if (unrun)\n',
    'else if (false)\n',
  ],
  [
    'gate: lost data after the upgrade is only a warning',
    'proof.mjs',
    "Object.freeze(['new-boots', 'data-intact'])",
    "Object.freeze(['new-boots'])",
  ],
  [
    'half-applied: findings next to a green schema check are ignored',
    'proof.mjs',
    'record.findings.length > 0 && schemaGreen',
    'record.findings.length > 0 && false',
  ],
  [
    'restore route: a warning need not name it, at the gate',
    'proof.mjs',
    'if (!namesRestoreRoute(record, found.warnings)) {',
    'if (false) {',
  ],
  [
    'restore route: a warned record is stamped without it',
    'proof.mjs',
    'if (warnings.length > 0) record.rollbackRoute = RESTORE_ROUTE;',
    '',
  ],
  [
    'restore route: a warning is recorded without it',
    'proof.mjs',
    'warnings.push({ check: name, detail, route: RESTORE_ROUTE })',
    'warnings.push({ check: name, detail })',
  ],
  [
    'warning: the log lines leave out the rollback route',
    'warnings.mjs',
    '`WARNING: the rollback route for this upgrade is ${RESTORE_ROUTE}: ${COST}`,',
    "'WARNING: see the record',",
  ],
  [
    'warning: the annotation is not escaped onto one line',
    'warnings.mjs',
    ".replaceAll('\\n', '%0A')",
    '',
  ],
  [
    'warning: the job summary is never written',
    'cli.mjs',
    'if (github.summaryFile !== undefined) {',
    'if (false) {',
  ],
  [
    'warning: a warned candidate exits non-zero',
    'cli.mjs',
    'accepted: 0, warned: 0,',
    'accepted: 0, warned: 2,',
  ],
  ['cli: every run exits 0', 'cli.mjs', 'return EXIT[record.outcome] ?? EXIT.error;', 'return 0;'],
  [
    'cli: verify exits 0 on a refusal',
    'cli.mjs',
    '    return EXIT.refused;',
    '    return EXIT.accepted;',
  ],
];

function runTests(dir) {
  const tests = COPIED.filter((f) => f.endsWith('.test.mjs'));
  const res = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-proof-sabotage-'));
  for (const f of COPIED) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  return dir;
}

function main() {
  let failures = 0;
  const base = scratchCopy();
  try {
    const baseline = runTests(base);
    if (baseline.code !== 0) {
      process.stdout.write(`BASELINE RED, so no red below would mean anything:\n${baseline.out}\n`);
      return 1;
    }
    process.stdout.write('baseline: green\n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  for (const [name, file, from, to] of CASES) {
    const dir = scratchCopy();
    try {
      const target = path.join(dir, file);
      const source = fs.readFileSync(target, 'utf8');
      const hits = source.split(from).length - 1;
      if (hits !== 1) {
        process.stdout.write(
          `CASE BROKEN: ${name}: the text to break appears ${hits} times, not once\n`
        );
        failures += 1;
        continue;
      }
      fs.writeFileSync(
        target,
        source.replace(from, () => to)
      );
      const broken = runTests(dir);
      if (broken.code === 0) {
        process.stdout.write(`STAYED GREEN (the control cannot fail): ${name}\n`);
        failures += 1;
      } else {
        process.stdout.write(`red when broken: ${name}\n`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    failures === 0
      ? `${CASES.length} of ${CASES.length} controls go red when broken; baseline green when restored\n`
      : `${failures} control(s) could not be shown to fail\n`
  );
  return failures === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main());
}
