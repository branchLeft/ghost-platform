import { mkdir, appendFile, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * LLD-8 §08b: "An export is a bulk read of everything a tenant holds, so
 * it is an audited action with the same weight as a support grant: who
 * asked, when, what the archive contained, and where it was delivered."
 * `08-portal.html` §07 records the equivalent support-grant audit trail as
 * Ghost's own (owned by Ghost, read by the portal); this component has no
 * such existing trail to read, so it keeps its own -- append-only, one
 * JSON line per export, journal-first the same way board_write.py's own
 * journal is (a write that lands here can always be replayed into
 * wherever this ships next; it is never lost by not having landed
 * somewhere else first).
 */
export interface ExportAuditEntry {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly occurredAt: string;
  readonly contents: readonly string[];
  readonly deliveredTo: string;
}

export interface AuditRecorder {
  record(entry: ExportAuditEntry): Promise<void>;
}

export function createFileAuditLog(path: string): AuditRecorder {
  return {
    async record(entry) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(path, line, { mode: 0o600 });
      // appendFile only applies `mode` when it creates the file; an
      // existing log with looser permissions (e.g. inherited from an
      // earlier, differently-configured run) is tightened on every write
      // rather than trusted from its first creation onward.
      const info = await stat(path);
      if ((info.mode & 0o777) !== 0o600) {
        await chmod(path, 0o600);
      }
    },
  };
}
