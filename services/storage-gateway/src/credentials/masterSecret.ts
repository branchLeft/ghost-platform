import { isAbsolute } from 'node:path';
import { inspect } from 'node:util';
import { readOwnerOnlyFile } from '../secretFile.js';

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
  /** The uid the file must belong to; defaults to this process's own. */
  readonly expectedUid?: number;
}

/**
 * Loads the master secret from the file named by
 * {@link MASTER_SECRET_FILE_ENV}: standard base64 text, at least
 * {@link MASTER_SECRET_MIN_BYTES} bytes decoded, in a regular owner-only
 * file belonging to this process's user. Anything else refuses to start.
 * A file, not the variable's value: the environment is readable from the
 * process table and from container inspection.
 */
export function loadMasterSecret(deps: MasterSecretSourceDeps): MasterSecret {
  const path = deps.env[MASTER_SECRET_FILE_ENV];
  if (path === undefined || path === '') {
    throw new MasterSecretError(`${MASTER_SECRET_FILE_ENV} is not set; refusing to start`);
  }
  if (!isAbsolute(path)) {
    throw new MasterSecretError(`${MASTER_SECRET_FILE_ENV} must be an absolute path`);
  }
  const raw = readOwnerOnlyFile(path, {
    label: 'master secret',
    expectedUid: deps.expectedUid ?? process.getuid?.() ?? -1,
    maxBytes: MASTER_SECRET_MAX_FILE_BYTES,
    fail: (message) => new MasterSecretError(message),
  });

  const text = raw.toString('utf8').trim();
  raw.fill(0);
  if (text === '' || !BASE64_PATTERN.test(text)) {
    throw new MasterSecretError('master secret file is not standard base64 text');
  }
  return MasterSecret.fromBytes(Buffer.from(text, 'base64'));
}
