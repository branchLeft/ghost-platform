import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Writes `content` to `path` by writing a temp file in the same directory
 * and renaming it into place. `rename` within one filesystem is atomic, so
 * a reader (the demo-gate, or this process's own next request) never
 * observes a partially-written file -- it sees either the old content or
 * the new content, never a byte-for-byte mix of both.
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
}

export async function removeFileIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Test helper only: an isolated directory this process owns outright. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
