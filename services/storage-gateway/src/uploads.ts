/** What an upload id was issued for: one tenant key, one bucket, one object key. */
export interface UploadBinding {
  readonly keyId: string;
  readonly bucket: string;
  readonly key: string;
}

/**
 * Remembers which tenant and object each multipart upload id belongs to. The
 * forwarder binds an id when the upstream answers a create, checks it on
 * every part, complete and abort, and releases it once the upload is
 * finished or aborted.
 */
export interface UploadBindings {
  /** False when the table is full, in which case the forwarder must fail the create. */
  bind(uploadId: string, binding: UploadBinding): boolean;
  isBound(uploadId: string, binding: UploadBinding): boolean;
  release(uploadId: string): void;
}

export const DEFAULT_UPLOAD_BINDING_LIMIT = 10_000;
export const DEFAULT_UPLOAD_BINDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * In memory and bounded. A gateway restart forgets every binding, so an
 * upload in flight across a restart is refused and the client starts again;
 * a persistent table would be a separate decision. Expired entries are
 * swept when the table is full, and a live entry is never evicted.
 */
export function createInMemoryUploadBindings(
  options: { limit?: number; ttlMs?: number; nowMs?: () => number } = {}
): UploadBindings {
  const limit = options.limit ?? DEFAULT_UPLOAD_BINDING_LIMIT;
  const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_BINDING_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const table = new Map<string, UploadBinding & { readonly expiresAtMs: number }>();

  return {
    bind(uploadId, binding) {
      const now = nowMs();
      if (table.size >= limit) {
        for (const [id, entry] of table) {
          if (entry.expiresAtMs <= now) table.delete(id);
        }
        if (table.size >= limit) return false;
      }
      table.set(uploadId, { ...binding, expiresAtMs: now + ttlMs });
      return true;
    },
    isBound(uploadId, binding) {
      const entry = table.get(uploadId);
      if (entry === undefined || entry.expiresAtMs <= nowMs()) return false;
      return (
        entry.keyId === binding.keyId &&
        entry.bucket === binding.bucket &&
        entry.key === binding.key
      );
    },
    release(uploadId) {
      table.delete(uploadId);
    },
  };
}
