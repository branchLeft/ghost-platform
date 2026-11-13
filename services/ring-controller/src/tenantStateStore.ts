import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BumpDependencies, BumpState, PersistSnapshot } from './bumpStateMachine.js';
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
  /** The bump's own stable id -- round-tripped so recovery reconstructs the exact `page()` dedupe key a live crash would have used. See `BumpStateMachineOptions.bumpId`. */
  bumpId: string;
  /** An abort was asked for and saved. Absent means none (a record written before this field existed). Recovery never lets an aborted tenant end `done`. */
  abortRequested?: boolean;
  /** Only meaningful for `state: 'failed-unsafe'`: the reason `page()` would be (or was) called with. */
  reason?: string;
}

/**
 * The one place a state-machine snapshot becomes a saved record. Every field
 * is named, never spread, so a field added to `PersistSnapshot` that is not
 * copied here is a type error rather than a silent loss. `abortRequested`
 * above all: a restart honours the abort the crashed process had saved only
 * if it reaches the record.
 */
export function recordFromSnapshot(
  tenantId: string,
  snapshot: PersistSnapshot,
  updatedAt: string
): PersistedTenantState {
  return {
    tenantId,
    state: snapshot.state,
    pageSent: snapshot.pageSent,
    abortRequested: snapshot.abortRequested,
    bumpId: snapshot.bumpId,
    reason: snapshot.reason,
    updatedAt,
  };
}

/** A `BumpDependencies.persist` that saves each snapshot of one tenant's machine to `store`. */
export function persistToStore(
  store: TenantStateStore,
  tenantId: string,
  now: () => string = () => new Date().toISOString()
): NonNullable<BumpDependencies['persist']> {
  return (snapshot) => store.save(recordFromSnapshot(tenantId, snapshot, now()));
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
