import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { GatewayLogger } from './admit.js';
import type { AllowedOperation, CredentialRecord, Refusal, RefusalCode } from './contracts.js';
import { refusal } from './refusal.js';
import type { UpstreamBody } from './upstream.js';

const MIB = 1024 * 1024;

/**
 * The body ceiling for a tenant whose credential names none, in MiB. It must
 * equal the platform's default upload ceiling; a test reads that file and
 * fails when the two drift.
 */
export const DEFAULT_BODY_CEILING_MIB = 128;

/** A body this size or smaller stays in memory; past it the body is spooled to disk. */
export const SPOOL_THRESHOLD_BYTES = 4 * MIB;

const SPOOL_PREFIX = 'bl-spool-';
const SPOOL_SUFFIX = '.part';
const SPOOL_NAME = /^bl-spool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

export type CeilingResult =
  { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly refusal: Refusal };

/**
 * The most body bytes this tenant may send in one request. An absent field
 * means the default; a field that is not a positive whole number of MiB is
 * refused, never read as "no cap".
 */
export function resolveBodyCeiling(credential: CredentialRecord): CeilingResult {
  const mib = credential.uploadCeilingMib ?? DEFAULT_BODY_CEILING_MIB;
  const bytes = mib * MIB;
  if (!Number.isSafeInteger(mib) || mib <= 0 || !Number.isSafeInteger(bytes)) {
    return { ok: false, refusal: refusal('credential-invalid') };
  }
  return { ok: true, bytes };
}

/** One open spool file. Injectable so a test can make a disk write fail. */
export interface SpoolFile {
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Opens a new spool file exclusively (it must not already exist), readable by the owner only. */
async function openSpoolFile(path: string): Promise<SpoolFile> {
  const handle = await open(path, 'wx', 0o600);
  return {
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    },
    close: () => handle.close(),
  };
}

export interface ReceiveBodyOptions {
  /** The most bytes accepted, from {@link resolveBodyCeiling}. */
  readonly ceilingBytes: number;
  /** Where spool files go. Required: there is no default, so no body lands in a shared temp directory. */
  readonly spoolDir: string;
  /** Defaults to {@link SPOOL_THRESHOLD_BYTES}. */
  readonly thresholdBytes?: number;
  /** The length the client declared, already parsed. A body that differs from it is incomplete. */
  readonly declaredLength?: number;
  /** Aborts the read when the client goes away. */
  readonly signal?: AbortSignal;
  readonly logger?: GatewayLogger;
  /** What a refusal log line carries. It never carries a key, bucket or target. */
  readonly log: {
    readonly method: string;
    readonly keyId?: string;
    readonly folder?: string;
    readonly operation?: AllowedOperation;
  };
  /** Test seam: open a spool file. */
  readonly openSpool?: (path: string) => Promise<SpoolFile>;
}

export type ReceiveBodyResult =
  | { readonly ok: true; readonly body: ReceivedBody }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * A body that was read, capped and hashed. The caller must {@link dispose} it
 * when the request ends, in a `finally`.
 */
export class ReceivedBody implements UpstreamBody {
  readonly sha256: string;
  readonly size: number;
  #memory: Buffer | undefined;
  readonly #path: string | undefined;
  #disposed = false;

  constructor(parts: {
    readonly sha256: string;
    readonly size: number;
    readonly memory?: Buffer;
    readonly path?: string;
  }) {
    this.sha256 = parts.sha256;
    this.size = parts.size;
    this.#memory = parts.memory;
    this.#path = parts.path;
  }

  /** A fresh stream of the whole body: one for each upstream attempt. */
  open(): Readable {
    if (this.#disposed) throw new Error('the body was disposed');
    if (this.#path !== undefined) return createReadStream(this.#path);
    return Readable.from([this.#memory ?? Buffer.alloc(0)], { objectMode: false });
  }

  /** Frees the body and deletes its spool file. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    if (this.#path !== undefined) await unlinkQuietly(this.#path);
    this.#memory = undefined;
    this.#disposed = true;
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNoEntry(error)) throw error;
  }
}

function isNoEntry(error: unknown): boolean {
  return (error as { readonly code?: unknown } | undefined)?.code === 'ENOENT';
}

/** A spool failure, kept apart from a failure of the client's own stream. */
class SpoolError extends Error {}

/**
 * Reads a request body under a hard cap, hashing it as it arrives. A body up
 * to the threshold stays in memory; a larger one is spooled to a file so that
 * memory stays near the threshold whatever the ceiling. The cap is checked
 * before each chunk is stored, so at most the ceiling is ever held, and a body
 * one byte over is refused. Never throws: every failure is a refusal, and a
 * spool file is removed on every path except success.
 */
export async function receiveBody(
  source: Readable,
  opts: ReceiveBodyOptions
): Promise<ReceiveBodyResult> {
  const threshold = opts.thresholdBytes ?? SPOOL_THRESHOLD_BYTES;
  const openSpool = opts.openSpool ?? openSpoolFile;
  const fail = (code: RefusalCode): ReceiveBodyResult => {
    const r = refusal(code);
    try {
      opts.logger?.refusal({
        event: 'request-refused',
        code: r.code,
        status: r.status,
        method: opts.log.method,
        ...(opts.log.keyId === undefined ? {} : { keyId: opts.log.keyId }),
        ...(opts.log.folder === undefined ? {} : { folder: opts.log.folder }),
        ...(opts.log.operation === undefined ? {} : { operation: opts.log.operation }),
      });
    } catch {
      // A logger that throws must not turn a refusal into a pass.
    }
    return { ok: false, refusal: r };
  };

  const declared = opts.declaredLength;
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
    source.destroy();
    return fail('body-incomplete');
  }
  if (declared !== undefined && declared > opts.ceilingBytes) {
    source.destroy();
    return fail('body-too-large');
  }
  if (opts.signal?.aborted) {
    source.destroy();
    return fail('body-incomplete');
  }

  const onAbort = (): void => {
    source.destroy();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const hash = createHash('sha256');
  const held: Buffer[] = [];
  let total = 0;
  let spool: SpoolFile | undefined;
  let spoolPath: string | undefined;
  let refused: RefusalCode | undefined;
  let received: ReceivedBody | undefined;

  try {
    for await (const piece of source) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
      if (declared !== undefined && total + chunk.length > declared) {
        refused = 'body-incomplete';
        break;
      }
      if (total + chunk.length > opts.ceilingBytes) {
        refused = 'body-too-large';
        break;
      }
      hash.update(chunk);
      total += chunk.length;
      try {
        if (spool === undefined && total > threshold) {
          spoolPath = join(opts.spoolDir, `${SPOOL_PREFIX}${randomUUID()}${SPOOL_SUFFIX}`);
          spool = await openSpool(spoolPath);
          for (const earlier of held.splice(0)) await spool.write(earlier);
        }
        if (spool === undefined) held.push(chunk);
        else await spool.write(chunk);
      } catch {
        throw new SpoolError('spool write failed');
      }
    }
    if (refused === undefined && declared !== undefined && total !== declared) {
      refused = 'body-incomplete';
    }
    if (refused === undefined) {
      if (spool !== undefined) {
        try {
          await spool.close();
        } catch {
          throw new SpoolError('spool close failed');
        }
        spool = undefined;
      }
      received = new ReceivedBody({
        sha256: hash.digest('hex'),
        size: total,
        ...(spoolPath === undefined ? { memory: Buffer.concat(held, total) } : { path: spoolPath }),
      });
      return { ok: true, body: received };
    }
  } catch (error) {
    refused = error instanceof SpoolError ? 'internal-error' : 'body-incomplete';
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (received === undefined) {
      source.destroy();
      try {
        await spool?.close();
      } catch {
        // The file is removed next; a failed close changes nothing.
      }
      if (spoolPath !== undefined) await unlinkQuietly(spoolPath).catch(() => undefined);
    }
  }
  return fail(refused ?? 'internal-error');
}

/**
 * Prepares the spool directory at start and removes what a killed process
 * left behind. It creates the directory (owner only) when absent, refuses a
 * symlink or a non-directory, and deletes only regular files named like our
 * own spool files, without descending. Returns how many it removed.
 */
export async function sweepSpoolDir(spoolDir: string): Promise<number> {
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  const info = await lstat(spoolDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('the spool directory must be a real directory, not a link');
  }
  let removed = 0;
  for (const entry of await readdir(spoolDir, { withFileTypes: true })) {
    if (!entry.isFile() || !SPOOL_NAME.test(entry.name)) continue;
    await unlinkQuietly(join(spoolDir, entry.name));
    removed += 1;
  }
  return removed;
}
