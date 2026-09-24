import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { Colour } from './literals.js';

/**
 * The slot's own fixed port, never whatever a descriptor claims. LLD-2 §01
 * (load-bearing): "no port to pick" -- a slot's ports are allocated once at
 * host build, and a reconcile that read them from caller input would let a
 * portal bug (or a forged descriptor) point the broker's own Admin API call
 * at a different slot's Ghost over loopback. Mirrors `config.ts`'s
 * `healthPortBase + Number(slot)` pattern: incidental in the exact base and
 * arithmetic (LLD-2 §01's figcaption says the port base is arbitrary
 * within its constraints), load-bearing in that it is computed from the
 * slot literal alone, never from the request body.
 */
export function slotPort(appPortBase: number, slot: SlotName, colour: Colour): number {
  return appPortBase + Number(slot) * 2 + (colour === 'b' ? 1 : 0);
}
