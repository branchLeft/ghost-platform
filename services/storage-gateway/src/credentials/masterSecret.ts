import { statSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { inspect } from 'node:util';

/** The environment variable naming the file that holds the master secret. */
export const MASTER_SECRET_FILE_ENV = 'STORAGE_GATEWAY_MASTER_SECRET_FILE';

/**
 * Below this many decoded bytes the master secret is refused. 32 bytes is
 * HKDF-SHA256's hash length: shorter input keying material caps the
 * strength of every tenant secret derived from it.
 */
export const MASTER_SECRET_MIN_BYTES = 32;

/** Above this the file is not a secret written by our own tooling. */
const MASTER_SECRET_MAX_FILE_BYTES = 1024;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const REDACTED = '[MasterSecret redacted]';

/**
 * Raised when the master secret cannot be loaded. The message names what is
 * wrong with the file and never its content, so it is safe to log.
 */
export class MasterSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterSecretError';
  }
}

/**
 * The gateway's one master secret. Its bytes are reachable only through
 * {@link MasterSecret.keyMaterial}; every way of turning the object into
 * text (string conversion, JSON, `util.inspect`, which `console.log` uses)
 * yields a fixed redaction, so a stray log line cannot leak it.
 */
export class MasterSecret {
  readonly #bytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  static fromBytes(bytes: Buffer): MasterSecret {
    if (bytes.length < MASTER_SECRET_MIN_BYTES) {
      throw new MasterSecretError(
        `master secret is ${bytes.length} bytes; at least ${MASTER_SECRET_MIN_BYTES} are required`
      );
    }
    return new MasterSecret(Buffer.from(bytes));
  }

  /** A copy of the key material, for the key derivation only. */
  keyMaterial(): Buffer {
    return Buffer.from(this.#bytes);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface MasterSecretSourceDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => Buffer;
  readonly fileMode?: (path: string) => number;
}

/**
 * Loads the master secret from the file named by
 * {@link MASTER_SECRET_FILE_ENV}. The file holds the secret as standard
 * base64 text. Start-up fails closed when the variable is unset, the path
 * is relative, the file is readable by group or others, is not base64, or
 * decodes to fewer than {@link MASTER_SECRET_MIN_BYTES} bytes.
 *
 * A file, not the variable's own value: a secret in the environment is
 * readable from the process table and from container inspection, and a
 * file can be delivered with owner-only permissions.
 */
export function loadMasterSecret(deps: MasterSecretSourceDeps): MasterSecret {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path));
  const fileMode = deps.fileMode ?? ((path: string) => statSync(path).mode);

  const path = deps.env[MASTER_SECRET_FILE_ENV];
  if (path === undefined || path === '') {
    throw new MasterSecretError(`${MASTER_SECRET_FILE_ENV} is not set; refusing to start`);
  }
  if (!isAbsolute(path)) {
    throw new MasterSecretError(`${MASTER_SECRET_FILE_ENV} must be an absolute path`);
  }

  let mode: number;
  let raw: Buffer;
  try {
    mode = fileMode(path);
    raw = readFile(path);
  } catch {
    throw new MasterSecretError('master secret file cannot be read; refusing to start');
  }
  if ((mode & 0o077) !== 0) {
    throw new MasterSecretError(
      'master secret file is readable by group or others; it must be mode 0600 or 0400'
    );
  }
  if (raw.length > MASTER_SECRET_MAX_FILE_BYTES) {
    throw new MasterSecretError('master secret file is larger than any secret we write');
  }

  const text = raw.toString('utf8').trim();
  if (text === '' || !BASE64_PATTERN.test(text)) {
    throw new MasterSecretError('master secret file is not standard base64 text');
  }
  return MasterSecret.fromBytes(Buffer.from(text, 'base64'));
}
