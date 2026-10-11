#!/usr/bin/env node
// Usage: node src/cli.mjs --from v6.55.0 --to v6.69.0 --versions <dir>
// <dir> is Ghost's migrations/versions directory from the TARGET tag's source.
// Exit 0 = fast-path, 2 = the consent verdict, 1 = an error (usage, read, or an
// unexpected tree). Exit 1 is never a verdict and never fast-path.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRange } from './classify.mjs';

const FOLDER_NAME = /^\d+\.\d+$/;

// The runner loads every entry not starting with a dot, whatever its extension.
// Accept only regular .js files; throw on any other entry, since one the
// classifier did not read could still be loaded and run.
export function readTree(versionsDir) {
  const folders = [];
  const migrations = [];
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || !FOLDER_NAME.test(entry.name)) {
      throw new Error(`unexpected entry in the versions directory: ${entry.name}`);
    }
    folders.push(entry.name);
    const dir = join(versionsDir, entry.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (file.name.startsWith('.')) continue;
      if (!file.isFile() || !file.name.endsWith('.js')) {
        throw new Error(
          `entry the runner would load is not a regular .js file: ${relative(versionsDir, join(dir, file.name))}`
        );
      }
      const full = join(dir, file.name);
      migrations.push({
        folder: entry.name,
        path: relative(versionsDir, full),
        source: readFileSync(full, 'utf8'),
      });
    }
  }
  if (folders.length === 0) {
    throw new Error(`no version folder in ${versionsDir}: not a migrations versions directory`);
  }
  return { folders, migrations };
}

export function readMigrations(versionsDir) {
  return readTree(versionsDir).migrations;
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
    const { folders, migrations } = readTree(args.versions);
    const result = classifyRange({ from: args.from, to: args.to, migrations, folders });
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
