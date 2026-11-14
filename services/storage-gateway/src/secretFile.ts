import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export interface OwnerOnlyFileOptions {
  /** What the file holds, for error text only: for example `master secret`. Never its content. */
  readonly label: string;
  /** The uid the file must belong to. */
  readonly expectedUid: number;
  /** Above this many bytes the file is not something our own tooling wrote. */
  readonly maxBytes: number;
  /** Builds the error to throw, so each caller keeps its own error type. */
  readonly fail: (message: string) => Error;
}

/**
 * Opens the file once, refusing a symlink, then checks and reads through that
 * one descriptor, so what is checked is what is read. The file must be a
 * regular file, owned by the expected user, and closed to group and others.
 * The returned buffer is the caller's to wipe.
 */
export function readOwnerOnlyFile(path: string, options: OwnerOnlyFileOptions): Buffer {
  const { label, expectedUid, maxBytes, fail } = options;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw fail(`${label} file cannot be opened (missing, or a symlink)`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw fail(`${label} path is not a regular file`);
    if (stat.uid !== expectedUid) throw fail(`${label} file is not owned by the gateway user`);
    if ((stat.mode & 0o077) !== 0) {
      throw fail(`${label} file is readable by group or others; it must be mode 0600 or 0400`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw fail(`${label} file is larger than any secret we write`);
    }
    const contents = Buffer.from(buffer.subarray(0, length));
    buffer.fill(0);
    return contents;
  } finally {
    closeSync(fd);
  }
}
