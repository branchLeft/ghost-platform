import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Refusal } from './contracts.js';
import { refusal } from './refusal.js';

const MIB = 1024 * 1024;

/** The default per-tenant body cap, which is the tenant's upload ceiling. */
export const DEFAULT_BODY_CAP_BYTES = 128 * MIB;
/** Bodies larger than this are written to disk as they arrive instead of held in memory. */
export const DEFAULT_SPOOL_THRESHOLD_BYTES = 4 * MIB;
export const SPOOL_SUFFIX = '.spool';

/** A body that has been fully received and hashed, and can be read again for each upstream attempt. */
export interface ReceivedBody {
  /** Lower-case hex SHA-256 of exactly the bytes {@link open} yields. */
  readonly sha256: string;
  readonly size: number;
  open(): Readable;
  /** Removes the spool file, if any. Safe to call twice. */
  dispose(): Promise<void>;
}

export type BodyFailure = 'too-large' | 'aborted' | 'read-error' | 'spool-error';

export type BodyResult =
  | { readonly ok: true; readonly body: ReceivedBody }
  | { readonly ok: false; readonly reason: BodyFailure; readonly refusal: Refusal };

export interface BodyStageOptions {
  /** Most bytes accepted; the byte after this is refused. */
  readonly capBytes: number;
  /** Where spool files live: a directory only the gateway can read. */
  readonly spoolDir: string;
  readonly spoolThresholdBytes?: number;
  /** The request's `content-length`, when it declared one: a larger value is refused unread. */
  readonly declaredLength?: number;
  /** Aborts the receive, and removes what it spooled, when the client goes away. */
  readonly signal?: AbortSignal;
}

export interface BodyCapPolicy {
  /** The cap for a tenant, keyed by its credential key id. */
  capFor(keyId: string): number;
}

function assertSize(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer number of bytes`);
  }
}

/** One cap for every tenant unless raised for one, which is how a tenant's upload ceiling is raised. */
export function createBodyCapPolicy(
  options: {
    readonly defaultBytes?: number;
    readonly overrides?: Readonly<Record<string, number>>;
  } = {}
): BodyCapPolicy {
  const defaultBytes = options.defaultBytes ?? DEFAULT_BODY_CAP_BYTES;
  assertSize('defaultBytes', defaultBytes);
  const overrides = new Map(Object.entries(options.overrides ?? {}));
  for (const [keyId, bytes] of overrides) assertSize(`the cap for ${keyId}`, bytes);
  return { capFor: (keyId) => overrides.get(keyId) ?? defaultBytes };
}

const fail = (reason: BodyFailure): BodyResult => ({
  ok: false,
  reason,
  refusal: refusal(reason === 'too-large' ? 'body-too-large' : 'internal-error'),
});

/** Writes every byte of the chunk, as a file write may stop short. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

/**
 * Receives a request body under the tenant's cap. The digest is computed as
 * the bytes arrive. Up to the spool threshold the body is held in memory;
 * past it, the held bytes move to a file and the rest goes straight to disk,
 * so memory use does not grow with the body. A failure removes any file it
 * made before it returns.
 */
export async function readBody(
  source: AsyncIterable<Uint8Array>,
  options: BodyStageOptions
): Promise<BodyResult> {
  assertSize('capBytes', options.capBytes);
  const threshold = options.spoolThresholdBytes ?? DEFAULT_SPOOL_THRESHOLD_BYTES;
  assertSize('spoolThresholdBytes', threshold);
  const { capBytes, signal } = options;
  if (options.declaredLength !== undefined && options.declaredLength > capBytes) {
    return fail('too-large');
  }

  const hash = createHash('sha256');
  let held: Buffer[] = [];
  let heldBytes = 0;
  let total = 0;
  let handle: FileHandle | undefined;
  let path: string | undefined;
  const aborted = (): boolean => signal?.aborted === true;
  const stopSource = (): void => {
    (source as { destroy?: () => void }).destroy?.();
  };
  signal?.addEventListener('abort', stopSource, { once: true });

  const discard = async (): Promise<void> => {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (path !== undefined) await unlink(path).catch(() => undefined);
    path = undefined;
  };

  try {
    if (aborted()) return fail('aborted');
    for await (const piece of source) {
      if (aborted()) {
        await discard();
        return fail('aborted');
      }
      const chunk = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      total += chunk.length;
      if (total > capBytes) {
        stopSource();
        await discard();
        return fail('too-large');
      }
      hash.update(chunk);
      if (handle === undefined && heldBytes + chunk.length <= threshold) {
        // A source may reuse its buffer, so what is kept is a copy.
        held.push(Buffer.from(chunk));
        heldBytes += chunk.length;
        continue;
      }
      if (handle === undefined) {
        path = join(options.spoolDir, `${randomUUID()}${SPOOL_SUFFIX}`);
        handle = await open(path, 'wx', 0o600);
        for (const kept of held) await writeAll(handle, kept);
        held = [];
        heldBytes = 0;
      }
      await writeAll(handle, chunk);
    }
  } catch (err) {
    const wasSpooling = path !== undefined;
    await discard();
    if (aborted()) return fail('aborted');
    const code = (err as { code?: unknown }).code;
    return fail(
      wasSpooling && typeof code === 'string' && code.startsWith('E') ? 'spool-error' : 'read-error'
    );
  } finally {
    signal?.removeEventListener('abort', stopSource);
  }

  const sha256 = hash.digest('hex');
  if (handle === undefined) {
    const bytes = Buffer.concat(held);
    return {
      ok: true,
      body: {
        sha256,
        size: bytes.length,
        open: () => Readable.from([bytes]),
        dispose: async () => undefined,
      },
    };
  }
  try {
    await handle.close();
  } catch {
    await discard();
    return fail('spool-error');
  }
  const file = path as string;
  let disposed = false;
  return {
    ok: true,
    body: {
      sha256,
      size: total,
      open: () => {
        if (disposed) throw new Error('the body has been disposed');
        return createReadStream(file);
      },
      dispose: async () => {
        disposed = true;
        await unlink(file).catch(() => undefined);
      },
    },
  };
}

/**
 * Receives the body, runs `use` with it, and removes any spool file whether
 * `use` returns, throws or the receive failed. `use` is never called for a
 * refused body, so nothing reaches the storage service.
 */
export async function withBody<T>(
  source: AsyncIterable<Uint8Array>,
  options: BodyStageOptions,
  use: (body: ReceivedBody) => Promise<T>
): Promise<{ readonly ok: true; readonly value: T } | Extract<BodyResult, { ok: false }>> {
  const received = await readBody(source, options);
  if (!received.ok) return received;
  try {
    return { ok: true, value: await use(received.body) };
  } finally {
    await received.body.dispose();
  }
}

/**
 * Removes every spool file left by an earlier process, which a killed gateway
 * cannot clean up itself. Call once at start, before any request is served.
 */
export async function clearSpoolDir(spoolDir: string): Promise<number> {
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const name of await readdir(spoolDir)) {
    if (!name.endsWith(SPOOL_SUFFIX)) continue;
    await unlink(join(spoolDir, name));
    removed += 1;
  }
  return removed;
}
