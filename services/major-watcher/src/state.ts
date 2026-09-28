import { readFile, writeFile } from 'node:fs/promises';
import type { WatcherState } from './detect.js';

// This module only ever sees a local path -- the workflow around it is
// what makes the file survive a runner restart. A missing or malformed
// state file is a hard error, never a default: defaulting would risk a
// page for a major announced long ago. See ../README.md#state.

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
