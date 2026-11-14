import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** A file the controller takes orders or facts from is not one it can trust. */
export class TrustedFileError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string
  ) {
    super(`${path} cannot be trusted: ${problem}.`);
    this.name = 'TrustedFileError';
  }
}

const GROUP_OR_OTHER_WRITE = 0o022;

/**
 * Reads one JSON file that decides what the controller does (its settings,
 * the recorded approvals, the tenant register). The check is on the opened
 * handle, so nothing can be swapped in after it: a symbolic link, anything that
 * is not a regular file, a file another user owns and a file another user could
 * write are all refused, because whoever can write it can approve onboarding.
 * A missing or unparseable file is refused too: the controller never goes on
 * without it.
 */
export async function readTrustedJson(path: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new TrustedFileError(
      path,
      code === 'ELOOP' ? 'it is a symbolic link' : 'it cannot be opened'
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TrustedFileError(path, 'it is not a regular file');
    if (info.uid !== process.getuid?.()) {
      throw new TrustedFileError(path, 'it belongs to another user');
    }
    if ((info.mode & GROUP_OR_OTHER_WRITE) !== 0) {
      throw new TrustedFileError(path, 'other users can write it');
    }
    const text = await file.readFile('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TrustedFileError(path, 'it is not JSON');
    }
  } finally {
    await file.close();
  }
}
