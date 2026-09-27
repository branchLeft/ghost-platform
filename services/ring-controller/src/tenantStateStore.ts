import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BumpState } from './bumpStateMachine.js';
import { removeFileIfPresent, writeFileAtomic } from './atomicFile.js';

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve.
function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | undefined)?.code;
}

/**
 * The durable record of one tenant's bump. `state` is what a restart must
 * recover against; `pageSent` rides along so a tenant that already paged
 * before a crash carries that fact into the next process rather than
 * losing it to an in-memory field.
 */
export interface PersistedTenantState {
  tenantId: string;
  state: BumpState;
  pageSent: boolean;
  updatedAt: string;
  /** Only meaningful for `state: 'failed-unsafe'`: the reason `page()` would be (or was) called with. */
  reason?: string;
}

export interface TenantStateStore {
  save(record: PersistedTenantState): Promise<void>;
  load(tenantId: string): Promise<PersistedTenantState | undefined>;
  remove(tenantId: string): Promise<void>;
  /** Every persisted record, for startup recovery to sweep. */
  list(): Promise<PersistedTenantState[]>;
}

/**
 * A tenant id can hold characters a filesystem shouldn't see raw (`/`,
 * null). This is a defensive floor, not a real namespacing scheme -- the
 * caller is expected to pass a real tenant id, not untrusted input.
 */
function fileNameFor(tenantId: string): string {
  const safe = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}.json`;
}

export function createFileTenantStateStore(dir: string): TenantStateStore {
  const pathFor = (tenantId: string) => join(dir, fileNameFor(tenantId));
  let dirReady: Promise<void> | undefined;
  const ensureDir = (): Promise<void> => {
    dirReady ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return dirReady;
  };

  return {
    async save(record) {
      await ensureDir();
      await writeFileAtomic(pathFor(record.tenantId), JSON.stringify(record));
    },

    async load(tenantId) {
      try {
        const content = await readFile(pathFor(tenantId), 'utf8');
        return JSON.parse(content) as PersistedTenantState;
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          return undefined;
        }
        throw err;
      }
    },

    async remove(tenantId) {
      await removeFileIfPresent(pathFor(tenantId));
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          return [];
        }
        throw err;
      }
      const records: PersistedTenantState[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const content = await readFile(join(dir, name), 'utf8');
        records.push(JSON.parse(content) as PersistedTenantState);
      }
      return records;
    },
  };
}
