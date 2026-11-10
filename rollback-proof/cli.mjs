#!/usr/bin/env node
// Usage:
//   node rollback-proof/cli.mjs run --old <image> --new <image> --mysql <image> [--profile platform|stock] [--out report.json]
//   node rollback-proof/cli.mjs verify --report report.json --old <image> --new <image>
// Exit 0 accepts the candidate. Exit 2 refuses it. Exit 1 is an error (bad
// arguments, an unreadable record, a run that did not finish): not an
// acceptance either, so a caller must treat every non-zero exit as a refusal.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runProof, verifyReport } from './proof.mjs';

const PROFILES = ['platform', 'stock'];

export const EXIT = Object.freeze({ accepted: 0, error: 1, refused: 2 });

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
    const reasons = verifyReport(record, { oldImage: values.old, newImage: values.new });
    if (reasons.length === 0) {
      out('ACCEPTED: the record holds every required check, all green');
      return EXIT.accepted;
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
  });
  process.exit(code);
}
