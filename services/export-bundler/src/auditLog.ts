import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * LLD-8 §08b: "An export is a bulk read of everything a tenant holds, so
 * it is an audited action with the same weight as a support grant: who
 * asked, when, what the archive contained, and where it was delivered."
 * Append-only, one JSON line per export.
 */
export interface ExportAuditEntry {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly occurredAt: string;
  readonly contents: readonly string[];
  /** Whether the manifest claimed the archive complete; false names a short archive in the record too. */
  readonly complete: boolean;
  readonly deliveredTo: string;
  /** The support grant the export ran under. */
  readonly grant: { readonly lane: string; readonly reference: string };
  /** The account whose session performed the export, from the tenant's own config. */
  readonly supportIdentity: string;
  /** The fingerprint of the one `age` recipient the archive is encrypted to. */
  readonly encryptedTo: string;
  /** Ties this record to one archive file: the SHA-256 of its ciphertext. */
  readonly archiveSha256: string;
}

export interface AuditRecorder {
  record(entry: ExportAuditEntry): Promise<void>;
}

export class AuditWriteError extends Error {
  constructor(detail: string) {
    super(`the audit record could not be written (${detail})`);
    this.name = 'AuditWriteError';
  }
}

export function createFileAuditLog(path: string): AuditRecorder {
  return {
    async record(entry) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        // One write of one whole line to an O_APPEND file, then fsync: a
        // record is either all there or absent, never interleaved or torn
        // by a concurrent run.
        const handle = await open(path, 'a', 0o600);
        try {
          await handle.write(`${JSON.stringify(entry)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // The open mode applies only on creation; a looser existing log is
        // tightened on every write.
        await chmod(path, 0o600);
      } catch (err) {
        throw new AuditWriteError((err as { code?: string }).code ?? (err as Error).message);
      }
    },
  };
}
