import { describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { slotAllocation, slotHealthPort, slotPort, slotUid } from '../../src/slotPorts.js';

/**
 * These formulas are the one authority both item 1's refusal (`app.ts`)
 * and the Admin API's own port selection (`app.ts`'s `attempt()`) read
 * from -- a bug in the formula itself would pass both undetected if only
 * proven indirectly through the full HTTP request path. Tested here as
 * pure functions of `(base, slot, colour)` alone, with no descriptor and
 * no HTTP server involved.
 */
describe('slotPorts', () => {
  it('slotPort: colour "a" is the even base, "b" is base + 1', () => {
    expect(slotPort(9300, '0' as SlotName, 'a')).toBe(9300);
    expect(slotPort(9300, '0' as SlotName, 'b')).toBe(9301);
  });

  it('slotPort: advances by 2 per slot, independent of colour', () => {
    expect(slotPort(9300, '2' as SlotName, 'a')).toBe(9304);
    expect(slotPort(9300, '2' as SlotName, 'b')).toBe(9305);
    expect(slotPort(9300, '6' as SlotName, 'a')).toBe(9312);
  });

  it('slotHealthPort: advances by 1 per slot', () => {
    expect(slotHealthPort(9100, '0' as SlotName)).toBe(9100);
    expect(slotHealthPort(9100, '6' as SlotName)).toBe(9106);
  });

  it('slotUid: advances by 1 per slot', () => {
    expect(slotUid(30001, '0' as SlotName)).toBe(30001);
    expect(slotUid(30001, '6' as SlotName)).toBe(30007);
  });

  it('slotAllocation: bundles all four values for one slot consistently with the individual functions', () => {
    const slot = '3' as SlotName;
    const allocation = slotAllocation(30001, 9300, 9100, slot);
    expect(allocation).toEqual({
      uid: slotUid(30001, slot),
      ports: {
        a: slotPort(9300, slot, 'a'),
        b: slotPort(9300, slot, 'b'),
        health: slotHealthPort(9100, slot),
      },
    });
    expect(allocation).toEqual({ uid: 30004, ports: { a: 9306, b: 9307, health: 9103 } });
  });

  it('two different slots never share a port or a uid', () => {
    const a = slotAllocation(30001, 9300, 9100, '1' as SlotName);
    const b = slotAllocation(30001, 9300, 9100, '2' as SlotName);
    expect(a.uid).not.toBe(b.uid);
    expect(a.ports.a).not.toBe(b.ports.a);
    expect(a.ports.b).not.toBe(b.ports.b);
    expect(a.ports.health).not.toBe(b.ports.health);
    // Nor does one slot's own colour pair collide with itself.
    expect(a.ports.a).not.toBe(a.ports.b);
  });
});
