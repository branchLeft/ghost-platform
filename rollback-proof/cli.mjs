#!/usr/bin/env node
// Usage:
//   node rollback-proof/cli.mjs run --old <image> --new <image> --mysql <image> [--profile platform|stock] [--out report.json]
//   node rollback-proof/cli.mjs verify --report report.json --old <image> --new <image>
// Exit 0 accepts the candidate, with or without warnings: a rollback check that
// is red is a warning that names the rollback route (restore-from-backup), and
// is printed as WARNING lines, a ::warning annotation and a job summary under
// GitHub Actions. Exit 2 refuses it. Exit 1 is an error (bad arguments, an
// unreadable record, a run that did not finish): not an acceptance either, so a
// caller must treat every non-zero exit as a refusal.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assessReport, runProof } from './proof.mjs';
import { annotation, summaryMarkdown, warningLines } from './warnings.mjs';

const PROFILES = ['platform', 'stock'];

export const EXIT = Object.freeze({ accepted: 0, warned: 0, error: 1, refused: 2 });

const FLAGS = {
  run: ['old', 'new', 'mysql', 'out', 'profile'],
  verify: ['report', 'old', 'new'],
};
const REQUIRED = {
  run: ['old', 'new', 'mysql'],
  verify: ['report', 'old', 'new'],
};

function parse(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(FLAGS, command ?? '')) {
    throw new Error(`usage: cli.mjs <${Object.keys(FLAGS).join('|')}> --flag value ...`);
  }
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const name = flag?.startsWith('--') ? flag.slice(2) : undefined;
    if (name === undefined || !FLAGS[command].includes(name)) {
      throw new Error(`unknown argument ${String(flag)} for ${command}`);
    }
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
      throw new Error(`--${name} needs a value`);
    }
    values[name] = rest[i + 1];
  }
  for (const name of REQUIRED[command]) {
    if (values[name] === undefined) throw new Error(`--${name} is required for ${command}`);
  }
  return { command, values };
}

/**
 * Shows a warned candidate: log lines always. The annotation and the job
 * summary come only from `verify`, the gate step, so a job that runs and then
 * verifies shows each once.
 */
function showWarnings(warnings, { out, appendFile, github = {} }, { gate }) {
  for (const line of warningLines(warnings)) out(line);
  if (!gate) return;
  if (github.annotate) out(annotation(warnings));
  if (github.summaryFile !== undefined) {
    appendFile(github.summaryFile, `${summaryMarkdown(warnings)}\n`);
  }
}

/** Runs the command and returns the exit code; effects come in through `deps`. */
export async function main(argv, deps) {
  const { ops, out, err, readFile, writeFile } = deps;
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    err(e.message);
    return EXIT.error;
  }
  const { command, values } = parsed;
  if (command === 'verify') {
    let record;
    try {
      record = JSON.parse(readFile(values.report));
    } catch (e) {
      err(`cannot read the record ${values.report}: ${e.message}`);
      return EXIT.error;
    }
    const { reasons, warnings } = assessReport(record, {
      oldImage: values.old,
      newImage: values.new,
    });
    if (reasons.length === 0 && warnings.length === 0) {
      out('ACCEPTED: the record holds every required check, all green');
      return EXIT.accepted;
    }
    if (reasons.length === 0) {
      out('WARNED: accepted; the record holds every required check and the way back is red');
      showWarnings(warnings, deps, { gate: true });
      return EXIT.warned;
    }
    for (const reason of reasons) out(`REFUSED: ${reason}`);
    return EXIT.refused;
  }
  const profile = values.profile ?? 'platform';
  if (!PROFILES.includes(profile)) {
    err(`--profile must be one of ${PROFILES.join(', ')}`);
    return EXIT.error;
  }
  const record = await runProof({
    ops: typeof ops === 'function' ? ops({ profile }) : ops,
    oldImage: values.old,
    newImage: values.new,
    mysqlImage: values.mysql,
    profile,
    log: (line) => err(line),
  });
  writeFile(values.out ?? 'rollback-report.json', `${JSON.stringify(record, null, 2)}\n`);
  for (const c of record.checks) out(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  out(`timings (ms): ${JSON.stringify(record.timings)}`);
  out(`${record.outcome.toUpperCase()}: old ${values.old} on data ${values.new} migrated`);
  if (record.warnings.length > 0) showWarnings(record.warnings, deps, { gate: false });
  return EXIT[record.outcome] ?? EXIT.error;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { dockerOps } = await import('./docker-ops.mjs');
  const code = await main(process.argv.slice(2), {
    ops: ({ profile }) => dockerOps({ profile, log: (line) => process.stderr.write(`${line}\n`) }),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, text) => fs.writeFileSync(p, text),
    appendFile: (p, text) => fs.appendFileSync(p, text),
    github: {
      annotate: process.env.GITHUB_ACTIONS === 'true',
      summaryFile: process.env.GITHUB_STEP_SUMMARY,
    },
  });
  process.exit(code);
}
