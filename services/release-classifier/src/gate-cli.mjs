#!/usr/bin/env node
// Usage: node src/gate-cli.mjs --record <file> --pinned v6.65.0 --target v6.66.0
// <file> is the JSON the steps CLI printed. Prints the verdict as JSON.
// Exit 0 = accepted, 2 = refused (including a record that cannot be read or parsed),
// 1 = a usage error. Exit 1 is never an acceptance: a caller treats any non-zero
// exit as refused.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL, assertReleaseReversible } from './gate.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`expected --record, --pinned, --target with values; got: ${argv.join(' ')}`);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  for (const k of ['record', 'pinned', 'target']) {
    if (!args[k]) throw new Error(`missing --${k}`);
  }
  return args;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`release-classifier gate: ${err.message}\n`);
    return 1;
  }
  let record;
  let verdict;
  try {
    record = JSON.parse(readFileSync(args.record, 'utf8'));
  } catch (err) {
    verdict = { ok: false, reason: REFUSAL.RECORD_UNREADABLE, detail: err.message };
  }
  verdict ??= assertReleaseReversible(record, { pinned: args.pinned, target: args.target });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  return verdict.ok ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
