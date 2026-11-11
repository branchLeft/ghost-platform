#!/usr/bin/env node
// The signing job's own check on the predicate file it is about to sign.
//   node promote/check-predicate.mjs --predicate FILE --digest sha256:HEX \
//     --version v6.66.0 --from-version v6.65.0
// Exit 0 accepted, 2 refused (including a file that cannot be read), 1 a usage
// error. Exit 1 is never an acceptance. No dependency beyond node built-ins.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkPredicate } from './shape.mjs';

export function main(argv, write = (line) => process.stdout.write(`${line}\n`)) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) {
      process.stderr.write(`promote check-predicate: expected --name value pairs\n`);
      return 1;
    }
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['predicate', 'digest', 'version', 'from-version']) {
    if (!flags[k]) {
      process.stderr.write(`promote check-predicate: missing --${k}\n`);
      return 1;
    }
  }
  let verdict;
  try {
    const predicate = JSON.parse(fs.readFileSync(flags.predicate, 'utf8'));
    verdict = checkPredicate(predicate, {
      digest: flags.digest,
      version: flags.version,
      fromVersion: flags['from-version'],
    });
  } catch (err) {
    verdict = { ok: false, reason: 'predicate-unreadable', detail: err.message };
  }
  write(verdict.ok ? 'PREDICATE ACCEPTED' : `REFUSED ${verdict.reason}: ${verdict.detail}`);
  return verdict.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
