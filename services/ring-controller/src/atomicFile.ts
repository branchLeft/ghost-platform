import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Atomic write: temp file, fsync, rename, fsync the directory. See
 * README.md in this directory for why each step matters.
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
