import type { SlotName } from '@branchleft/ghost-platform-render-core';

/**
 * Serialises `/reconcile` and `/reset` per slot: `claim` and its caller's
 * check of the result run with no `await` between them, so two concurrent
 * handlers cannot both see `true` for the same slot. This in-memory lock is
 * the actual concurrency control; `stateStore.ts`'s persisted phase only
 * records the result for `/status`. See slotLock.md#slotlock.
 */
export interface SlotLock {
  claim(slot: SlotName): boolean;
  release(slot: SlotName): void;
}

export function createSlotLock(): SlotLock {
  const held = new Set<SlotName>();
  return {
    claim(slot) {
      if (held.has(slot)) return false;
      held.add(slot);
      return true;
    },
    release(slot) {
      held.delete(slot);
    },
  };
}
