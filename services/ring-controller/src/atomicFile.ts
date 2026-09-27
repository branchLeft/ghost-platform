import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Writes `content` to `path` by writing a temp file in the same directory,
 * fsyncing it, renaming it into place, then fsyncing the directory. `rename`
 * within one filesystem is atomic, so a reader (a restarted controller
 * recovering this same tenant) never observes a partially-written file --
 * either the old content or the new content, never a mix. The directory
 * fsync matters as much as the file's: without it, a crash can persist the
 * rename in the page cache but lose it on disk, so a recovering process
 * reads the state from *before* the write that supposedly already
 * happened -- exactly the gap this exists to close for a tenant crashing
 * mid-`applying`.
 *
 * Same shape as services/broker's own atomic-write helper (not imported
 * across the service boundary -- each service is its own package, so this
 * is the same well-understood pattern re-derived locally, not a second
 * design).
 */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(tmpPath, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
  await syncDirectory(dir);
}

export async function removeFileIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Test helper only: an isolated directory this process owns outright. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
