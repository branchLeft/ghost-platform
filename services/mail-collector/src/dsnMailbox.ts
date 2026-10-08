import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface RawDsn {
  /** Opaque handle for markProcessed. */
  ref: string;
  raw: string;
}

/** Where mx1's delivery status notifications for the collector's return path land. */
export interface DsnMailbox {
  list(): Promise<RawDsn[]>;
  /** Retires a notification once its information has reached the spool (or can never reach one). Never deletes it. */
  markProcessed(ref: string): Promise<void>;
}

const MAX_PER_LIST = 200;
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * A directory of `.eml` files, one notification each. Processed files move
 * to `processed/` beside them rather than being deleted, so every outcome
 * ever reported stays auditable. How files get into the directory is the
 * mx1-side half of this story (shared-infra mail/ plus the runbook); this
 * module only reads them.
 */
export function createDirectoryDsnMailbox(dir: string): DsnMailbox {
  return {
    async list(): Promise<RawDsn[]> {
      const names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.eml'))
        .map((e) => e.name)
        .sort()
        .slice(0, MAX_PER_LIST);
      const out: RawDsn[] = [];
      for (const name of names) {
        const buf = await readFile(join(dir, name));
        // An oversized file is not a DSN; it is retired unread by returning empty text.
        out.push({ ref: name, raw: buf.length > MAX_FILE_BYTES ? '' : buf.toString('utf8') });
      }
      return out;
    },
    async markProcessed(ref: string): Promise<void> {
      if (ref.includes('/') || ref.includes('\\') || ref.startsWith('.')) {
        throw new Error(`unsafe mailbox ref: ${ref}`);
      }
      await mkdir(join(dir, 'processed'), { recursive: true });
      await rename(join(dir, ref), join(dir, 'processed', ref));
    },
  };
}
