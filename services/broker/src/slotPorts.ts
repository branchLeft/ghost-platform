import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { Colour } from './literals.js';

/**
 * The slot's own fixed port, never whatever a descriptor claims: a slot's
 * ports are allocated once at host build, and reading them from caller
 * input would let a forged descriptor point the broker's Admin API call at
 * a different slot's Ghost over loopback. See slotPorts.md#slotport.
 */
export function slotPort(appPortBase: number, slot: SlotName, colour: Colour): number {
  return appPortBase + Number(slot) * 2 + (colour === 'b' ? 1 : 0);
}

/** The slot's own fixed sidecar health port. Mirrors `slotPort`'s reasoning exactly. */
export function slotHealthPort(healthPortBase: number, slot: SlotName): number {
  return healthPortBase + Number(slot);
}

/**
 * The slot's own fixed uid, from the reserved range `render-core`'s
 * `TENANT_UID_MIN` anchors -- "root-owned uid 30001..30007 from the reserved
 * range" (LLD-2 §01), created once at host build. Same load-bearing reason as
 * `slotPort`: computed from the slot literal alone, never from a descriptor.
 */
export function slotUid(uidBase: number, slot: SlotName): number {
  return uidBase + Number(slot);
}

export interface SlotAllocation {
  readonly uid: number;
  readonly ports: { readonly a: number; readonly b: number; readonly health: number };
}

/** Every value LLD-2 §01 says is allocated once, at host build, for one slot. */
export function slotAllocation(
  uidBase: number,
  appPortBase: number,
  healthPortBase: number,
  slot: SlotName
): SlotAllocation {
  return {
    uid: slotUid(uidBase, slot),
    ports: {
      a: slotPort(appPortBase, slot, 'a'),
      b: slotPort(appPortBase, slot, 'b'),
      health: slotHealthPort(healthPortBase, slot),
    },
  };
}
