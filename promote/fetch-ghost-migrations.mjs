#!/usr/bin/env node
// Fetches Ghost's migrations/versions directory at one release tag, and nothing
// else, into a directory, and prints the commit the tag resolved to.
//   node promote/fetch-ghost-migrations.mjs --tag v6.66.0 --dest DIR
// DIR must not exist. Blobless, shallow and sparse: a few megabytes, no checkout
// of the rest of the tree. Exit 0 printed the commit; 1 anything else.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'https://github.com/TryGhost/Ghost.git';
export const VERSIONS_PATH = 'ghost/core/core/server/data/migrations/versions';
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export function fetchMigrations(
  { tag, dest },
  git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
) {
  if (!RELEASE_TAG.test(tag ?? '')) throw new RangeError(`not a plain release tag: ${tag}`);
  if (!dest) throw new RangeError('no destination');
  if (fs.existsSync(dest)) throw new RangeError(`destination exists: ${dest}`);
  fs.mkdirSync(dest, { recursive: true });
  git(['init', '--quiet'], dest);
  git(['remote', 'add', 'origin', UPSTREAM], dest);
  git(['sparse-checkout', 'set', '--no-cone', `/${VERSIONS_PATH}/`], dest);
  git(
    ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', `refs/tags/${tag}`],
    dest
  );
  git(['checkout', '--quiet', 'FETCH_HEAD'], dest);
  const commit = git(['rev-parse', 'HEAD'], dest).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`no commit for ${tag}`);
  if (!fs.existsSync(path.join(dest, VERSIONS_PATH))) {
    throw new Error(`${tag} has no ${VERSIONS_PATH}`);
  }
  return commit;
}

export function main(argv, write = (line) => process.stdout.write(`${line}\n`), git) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    flags[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  }
  try {
    write(fetchMigrations({ tag: flags.tag, dest: flags.dest }, git));
    return 0;
  } catch (err) {
    process.stderr.write(`promote fetch-ghost-migrations: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
