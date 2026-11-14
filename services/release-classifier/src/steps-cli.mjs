#!/usr/bin/env node
// Usage: node src/steps-cli.mjs --release v6.57.0=<dir> --release v6.58.0=<dir> ...
// Each <dir> is Ghost's migrations/versions directory at that tag, oldest release
// first; the first is the pinned release. Prints the per-step verdict as JSON.
// Exit 0 = every step reversible, 2 = a step is forward-only or unclassified,
// 1 = an error (usage, read, order). Exit 1 is never a verdict and never reversible.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTree } from './cli.mjs';
import { CLASS, classifySteps } from './steps.mjs';

function parseArgs(argv) {
  const releases = [];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key !== '--release' || value === undefined) {
      throw new Error(`expected --release <tag>=<versions dir> pairs; got: ${argv.join(' ')}`);
    }
    const at = value.indexOf('=');
    if (at < 1 || at === value.length - 1) throw new Error(`not <tag>=<dir>: ${value}`);
    releases.push({ tag: value.slice(0, at), dir: value.slice(at + 1) });
  }
  return releases;
}

// One directory for two tags would read the same tree twice and call the step reversible
// with 0 new files. Two copies of a tree (a patch release) are read as they are.
function refuseSharedDirectory(releases) {
  const seen = new Map();
  for (const { tag, dir } of releases) {
    const real = realpathSync(dir);
    if (seen.has(real)) {
      throw new Error(`the same directory is passed for ${seen.get(real)} and ${tag}`);
    }
    seen.set(real, tag);
  }
}

export function main(argv) {
  try {
    const parsed = parseArgs(argv);
    refuseSharedDirectory(parsed);
    const releases = parsed.map(({ tag, dir }) => ({
      tag,
      migrations: readTree(dir).migrations,
    }));
    const result = classifySteps({ releases });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.class === CLASS.REVERSIBLE ? 0 : 2;
  } catch (err) {
    process.stderr.write(`release-classifier steps: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
