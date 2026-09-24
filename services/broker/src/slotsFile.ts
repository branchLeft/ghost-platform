import { readFile } from 'node:fs/promises';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
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
 * a recycle can legitimately change a demo's hostname) with `entry`. The
 * read-modify-write is not itself transactional against a concurrent
 * writer; `wrapper.ts`'s per-slot flock (taken by the sudoers-enumerated
 * wrapper, not by this file) is what serialises two reconciles of the same
 * slot, and this file's own readers (`demo-gate`) tolerate torn reads by
 * refusing to admit rather than by trusting partial state -- see
 * `render-core/src/lease.ts`'s recycle contract.
 */
export async function upsertSlotEntry(path: string, entry: SlotsFileEntry): Promise<void> {
  const entries = await readEntries(path);
  const next = entries.filter((e) => e.slot !== entry.slot);
  next.push(entry);
  await writeEntries(path, next);
}

export async function removeSlotEntry(path: string, slot: SlotName): Promise<void> {
  const entries = await readEntries(path);
  const next = entries.filter((e) => e.slot !== slot);
  if (next.length !== entries.length) await writeEntries(path, next);
}
