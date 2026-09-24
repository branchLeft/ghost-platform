import { readFile } from 'node:fs/promises';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { createAsyncMutex, type AsyncMutex } from './asyncMutex.js';
import { writeFileAtomic } from './atomicFile.js';

/**
 * One entry in the shared slots file -- the exact shape
 * `services/demo-gate/src/slots.ts`'s `parseSlots` reads, since that
 * service is the file's only other reader/writer pairing and the two must
 * never drift. Duplicated rather than imported: the two services share no
 * runtime dependency on each other, only on `render-core` and this shape.
 */
export interface SlotsFileEntry {
  readonly host: string;
  readonly slot: SlotName;
  readonly gate: { readonly kind: 'passphrase'; readonly argon2idHash: string };
}

interface SlotsFileShape {
  readonly slots: readonly SlotsFileEntry[];
}

export class HostConflictError extends Error {
  constructor(
    readonly host: string,
    readonly heldBySlot: SlotName
  ) {
    super(`host "${host}" is already held by slot "${heldBySlot}"`);
    this.name = 'HostConflictError';
  }
}

// One mutex per slots-file path: this file is the only place that ever
// writes it, so a read-modify-write anywhere in this process -- across
// every slot -- goes through the same lock for that path. Keyed rather
// than a single module-level lock so two independent broker instances in
// one test process (different temp paths) never serialise against each
// other for no reason.
const mutexes = new Map<string, AsyncMutex>();
function mutexFor(path: string): AsyncMutex {
  let m = mutexes.get(path);
  if (!m) {
    m = createAsyncMutex();
    mutexes.set(path, m);
  }
  return m;
}

async function readEntries(path: string): Promise<SlotsFileEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as SlotsFileShape;
  return [...parsed.slots];
}

async function writeEntries(path: string, entries: readonly SlotsFileEntry[]): Promise<void> {
  const body: SlotsFileShape = { slots: entries };
  // Sorted by slot so the file's diff between recycles is confined to the
  // slot that actually changed -- the same reasoning render_slot_sudoers.py
  // applies to its own generated output.
  const sorted = [...body.slots].sort((a, b) => a.slot.localeCompare(b.slot));
  await writeFileAtomic(path, JSON.stringify({ slots: sorted }, null, 2) + '\n', 0o640);
}

/**
 * Replaces whatever entry currently names `slot` (by slot, not by host --
 * a recycle can legitimately change a demo's hostname) with `entry`, and
 * refuses outright if `entry.host` is already held by a *different* slot.
 *
 * The whole read-modify-write runs inside `mutexFor(path)`, which is the
 * only thing that makes this atomic: a per-slot lock (`slotLock.ts`) stops
 * two requests racing the *same* slot, but this file is shared across every
 * slot, so two different slots reconciling concurrently -- each holding its
 * own, different per-slot lock -- would otherwise still interleave their
 * reads and writes here and lose entries. There is no flock to rely on
 * either: the sudoers-enumerated wrapper's own per-slot flock (LLD-2 §02)
 * spans one privileged invocation, never this file, and does not exist yet.
 */
export async function upsertSlotEntry(path: string, entry: SlotsFileEntry): Promise<void> {
  await mutexFor(path).run(async () => {
    const entries = await readEntries(path);
    const conflict = entries.find((e) => e.host === entry.host && e.slot !== entry.slot);
    if (conflict) throw new HostConflictError(entry.host, conflict.slot);
    const next = entries.filter((e) => e.slot !== entry.slot);
    next.push(entry);
    await writeEntries(path, next);
  });
}

/**
 * A best-effort, read-only check used to refuse a conflicting reconcile
 * *before* any side effect runs (`app.ts`'s `attempt()`), rather than only
 * after the wrapper has already been started -- `upsertSlotEntry`'s own
 * conflict check is the atomic, race-free backstop this reads ahead of.
 */
export async function hostHeldByAnotherSlot(
  path: string,
  host: string,
  slot: SlotName
): Promise<SlotName | null> {
  const entries = await readEntries(path);
  const conflict = entries.find((e) => e.host === host && e.slot !== slot);
  return conflict ? conflict.slot : null;
}

export async function removeSlotEntry(path: string, slot: SlotName): Promise<void> {
  await mutexFor(path).run(async () => {
    const entries = await readEntries(path);
    const next = entries.filter((e) => e.slot !== slot);
    if (next.length !== entries.length) await writeEntries(path, next);
  });
}
