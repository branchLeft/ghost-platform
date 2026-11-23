// Text helpers shared by the root workflow tests. Each of these reads a
// workflow as text and asserts on it. The bodies here are the ones every caller
// used verbatim; a test whose copy differed in one detail keeps its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '..', '.github', 'workflows');

// Whole-line comments go, so text inside a comment can never satisfy a check.
export function stripCommentLines(text: string): string {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// A workflow under .github/workflows, with its whole-line comments removed.
export function uncommented(file: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf-8').replace(/^[ \t]*#.*$/gm, '');
}

// The text of one job: from its `  name:` line to the next job or the end.
// Searched after `jobs:` because a trigger can share a job's name (`push:`).
export function jobBlock(text: string, name: string): string {
  const jobsAt = text.indexOf('\njobs:');
  assert.ok(jobsAt > -1, 'workflow has a jobs section');
  const jobs = text.slice(jobsAt + 1);
  const start = jobs.search(new RegExp(`^  ${name}:\\n`, 'm'));
  assert.ok(start > -1, `workflow has a ${name} job`);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// Replace text that must be there: a mutation that silently changed nothing
// would let its case pass without proving anything.
export function swap(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

// The tag patterns under a workflow's `tags:` trigger.
export function tagPatterns(text: string): string[] {
  const block = text.match(/tags:\n((?:[ \t]+- .*\n)+)/);
  assert.ok(block, 'workflow has a tags trigger');
  return [...block[1].matchAll(/- '([^']+)'/g)].map((m) => m[1]);
}

// GitHub's tag filter is a glob over the whole ref name; the only operator
// used in these workflows is a `[0-9]+` run. Everything between runs is
// escaped as a literal, then the runs become a regex.
export function globToRegex(glob: string): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${glob.split('[0-9]+').map(literal).join('[0-9]+')}$`);
}
