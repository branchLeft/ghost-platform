import { readFile, writeFile } from 'node:fs/promises';
import type { WatcherState } from './detect.js';

// Dedupe state lives in one JSON file, read and written as plain files --
// the workflow around this CLI is what makes that file survive a runner
// restart (see README.md "State"): it lives on a dedicated, unprotected
// git branch, fetched before this runs and pushed back only when the
// content actually changed. Nothing in this module knows about git; it
// only ever sees a local path, which is what keeps it unit-testable with
// no network and no repository.
//
// A missing or malformed state file is a hard error, never a default.
// Defaulting `lastNotifiedMajor` to e.g. 0 would make the very first run
// against a real, already-mid-major-6 estate fire a page for a major that
// was announced over a year ago -- see test/unit/state.test.ts's sabotage
// case. Bootstrapping a new deployment is a deliberate, one-time write of
// this file to the *current* major line, never something the code infers.

export async function readState(path: string): Promise<WatcherState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `no dedupe state at ${path} -- this watcher refuses to guess a starting major. ` +
        `Seed it explicitly (see README.md "Bootstrapping") before the first scheduled run. Cause: ${String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dedupe state at ${path} is not valid JSON: ${String(err)}`);
  }

  const lastNotifiedMajor = (parsed as { lastNotifiedMajor?: unknown } | null)?.lastNotifiedMajor;
  if (
    typeof lastNotifiedMajor !== 'number' ||
    !Number.isInteger(lastNotifiedMajor) ||
    lastNotifiedMajor < 0
  ) {
    throw new Error(`dedupe state at ${path} has no valid integer "lastNotifiedMajor": ${raw}`);
  }

  return { lastNotifiedMajor };
}

export async function writeState(path: string, state: WatcherState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
