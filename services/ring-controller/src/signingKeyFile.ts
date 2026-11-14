import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

/**
 * Reads the promotion-record keys from files. The permission model the private
 * key file must meet, and why, is in README.md in this directory.
 */

export type KeyFileFailure =
  | 'missing'
  | 'not-permitted'
  | 'unreadable'
  | 'symlink'
  | 'not-a-regular-file'
  | 'owner-unknown'
  | 'wrong-owner'
  | 'loose-permissions'
  | 'too-large'
  | 'not-a-private-key'
  | 'not-a-public-key'
  | 'not-an-ed25519-key';

/**
 * Names the failure and the path, never the file's content: this error reaches
 * logs and the hold sink.
 */
export class KeyFileError extends Error {
  readonly code: KeyFileFailure;
  readonly path: string;

  constructor(code: KeyFileFailure, path: string) {
    super(`key file refused: ${code} (${JSON.stringify(path)})`);
    this.name = 'KeyFileError';
    this.code = code;
    this.path = path;
  }
}

export interface SigningKeyFileOptions {
  /** The uid that must own the file. Defaults to the process's effective uid. */
  ownerUid?: number;
}

/** A PKCS8 Ed25519 key is under 200 bytes; anything near this is not one. */
const MAX_KEY_BYTES = 4096;

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | undefined)?.code;
}

function failureFor(error: unknown): KeyFileFailure {
  switch (errorCode(error)) {
    case 'ENOENT':
      return 'missing';
    case 'EACCES':
    case 'EPERM':
      return 'not-permitted';
    case 'ELOOP':
      return 'symlink';
    default:
      return 'unreadable';
  }
}

/**
 * Loads the record-signing private key (PKCS8 PEM, Ed25519). Refused, with the
 * file never parsed, unless it is a regular file reached without following a
 * symlink, owned by the expected uid, with no group or other permission bit
 * set. The checks run on the opened file, so nothing can be swapped in between
 * the check and the read.
 */
export async function loadSigningKeyFile(
  path: string,
  options: SigningKeyFileOptions = {}
): Promise<KeyObject> {
  const ownerUid = options.ownerUid ?? process.geteuid?.();
  if (ownerUid === undefined) throw new KeyFileError('owner-unknown', path);

  let handle;
  try {
    // O_NONBLOCK: opening a FIFO would otherwise wait for a writer, before the type check.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new KeyFileError(failureFor(error), path);
  }
  let content: Buffer | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new KeyFileError('not-a-regular-file', path);
    if (stat.uid !== ownerUid) throw new KeyFileError('wrong-owner', path);
    if ((stat.mode & 0o077) !== 0) throw new KeyFileError('loose-permissions', path);
    if (stat.size > MAX_KEY_BYTES) throw new KeyFileError('too-large', path);
    try {
      content = await handle.readFile();
    } catch (error) {
      throw new KeyFileError(failureFor(error), path);
    }
    let key: KeyObject;
    try {
      key = createPrivateKey(content);
    } catch {
      throw new KeyFileError('not-a-private-key', path);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new KeyFileError('not-an-ed25519-key', path);
    return key;
  } finally {
    content?.fill(0);
    await handle.close();
  }
}

/**
 * Loads the committed public half (SPKI PEM, Ed25519). A private key in this
 * file is refused: `createPublicKey` would derive the public half from it, and
 * the signer-key check would then compare a key with itself.
 */
export async function loadPublicKeyFile(path: string): Promise<KeyObject> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    throw new KeyFileError(failureFor(error), path);
  }
  if (content.length > MAX_KEY_BYTES || content.includes('PRIVATE KEY')) {
    throw new KeyFileError('not-a-public-key', path);
  }
  let key: KeyObject;
  try {
    key = createPublicKey(content);
  } catch {
    throw new KeyFileError('not-a-public-key', path);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyFileError('not-an-ed25519-key', path);
  return key;
}
