import { validateSlotName, type SlotName } from '@branchleft/ghost-platform-render-core';

export type Colour = 'a' | 'b';
export type Verb = 'start' | 'stop';

/**
 * `render-core`'s `validateSlotName` accepts the general DNS-label shape
 * (used for hostnames too); LLD-2 §02's boundary is narrower -- exactly the
 * host-build's fixed set of literals, never merely "shaped like a slot
 * name". Both checks run: the shape check first (so the error for a
 * malformed value stays generic), the closed-set membership check second
 * and load-bearing.
 */
export function validateSlotLiteral(value: unknown, allowed: readonly string[]): SlotName {
  if (typeof value !== 'string') throw new Error('slot must be a string');
  const slot = validateSlotName(value);
  if (!allowed.includes(slot)) {
    throw new Error(`slot "${slot}" is not one of the enumerated slot literals`);
  }
  return slot;
}

export function validateColour(value: unknown): Colour {
  if (value !== 'a' && value !== 'b') {
    throw new Error('colour must be exactly "a" or "b"');
  }
  return value;
}
