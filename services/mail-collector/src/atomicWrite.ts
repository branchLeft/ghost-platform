import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write-to-temp, fsync, rename, fsync the directory: a crash at any point
 * leaves either the previous complete file or the new complete one, never a
 * torn file. Throws on any failure; the caller decides what a failed write
 * means for it.
 */
export function writeFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
