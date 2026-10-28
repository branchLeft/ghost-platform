import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import type { AllowedOperation } from '../contracts.js';

/**
 * The operations that put data into storage. An abort only removes an
 * unfinished upload, and reads and existence checks move nothing in, so
 * neither is stopped by a write switch.
 */
export const WRITE_OPERATIONS: ReadonlySet<AllowedOperation> = new Set([
  'PutObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
]);

export interface WriteKillSwitches {
  /** True when writes for this tenant are switched off, by its own switch or the global one. */
  writesBlocked(keyId: string): boolean;
  setGlobal(on: boolean): void;
  setTenant(keyId: string, on: boolean): void;
  state(): { readonly global: boolean; readonly tenants: readonly string[] };
}

interface Saved {
  global: boolean;
  tenants: string[];
}

function load(path: string): Saved {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { global: false, tenants: [] };
    throw err;
  }
  // A file that cannot be read in full is not "no switches": opening writes
  // that an operator switched off would be the failure this guards against.
  const parsed: unknown = JSON.parse(text);
  const record = parsed as { global?: unknown; tenants?: unknown };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof record.global !== 'boolean' ||
    !Array.isArray(record.tenants) ||
    !record.tenants.every((t) => typeof t === 'string')
  ) {
    throw new Error('the write kill switch file is damaged');
  }
  return { global: record.global, tenants: [...(record.tenants as string[])] };
}

function save(path: string, saved: Saved): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(saved)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * A global write switch and one per tenant. With a `path`, the switches are
 * read at start and saved at every change, so a restart does not quietly
 * turn writes back on. A damaged file stops the start.
 */
export function createWriteKillSwitches(
  options: { readonly path?: string } = {}
): WriteKillSwitches {
  const saved: Saved =
    options.path === undefined ? { global: false, tenants: [] } : load(options.path);
  let global = saved.global;
  const tenants = new Set(saved.tenants);
  const persist = (): void => {
    if (options.path !== undefined) save(options.path, { global, tenants: [...tenants].sort() });
  };
  return {
    writesBlocked: (keyId) => global || tenants.has(keyId),
    setGlobal(on) {
      global = on;
      persist();
    },
    setTenant(keyId, on) {
      if (on) tenants.add(keyId);
      else tenants.delete(keyId);
      persist();
    },
    state: () => ({ global, tenants: [...tenants].sort() }),
  };
}
