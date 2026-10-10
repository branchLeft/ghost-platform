#!/usr/bin/env node
// Usage: node src/cli.mjs --from v6.55.0 --to v6.69.0 --versions <dir>
// <dir> is Ghost's migrations/versions directory from the TARGET tag's source.
// Exit 0 = fast-path, 2 = consent path, 1 = usage or read error.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRange } from './classify.mjs';

export function readMigrations(versionsDir) {
  const migrations = [];
  for (const folder of readdirSync(versionsDir)) {
    const dir = join(versionsDir, folder);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const full = join(dir, file);
      migrations.push({
        folder,
        path: relative(versionsDir, full),
        source: readFileSync(full, 'utf8'),
      });
    }
  }
  return migrations;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`expected --from, --to, --versions with values; got: ${argv.join(' ')}`);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  for (const k of ['from', 'to', 'versions']) {
    if (!args[k]) throw new Error(`missing --${k}`);
  }
  return args;
}

export function main(argv) {
  try {
    const args = parseArgs(argv);
    const result = classifyRange({
      from: args.from,
      to: args.to,
      migrations: readMigrations(args.versions),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.route === 'fast-path' ? 0 : 2;
  } catch (err) {
    process.stderr.write(`release-classifier: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
