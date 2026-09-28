import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { slotAllocation, slotHealthPort, slotPort, slotUid } from '../../src/slotPorts.js';

const GOLDEN_PORTS_PATH = fileURLToPath(
  new URL('../../../../demo-host/provision/slot-ports.golden.json', import.meta.url)
);

interface GoldenPorts {
  readonly appPortBase: number;
  readonly healthPortBase: number;
  readonly slots: readonly {
    readonly slot: string;
    readonly a: number;
    readonly b: number;
    readonly health: number;
  }[];
}

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

  // --- `demo-host/provision/render_demo_edge.py` mirrors this file's own
  // formula deliberately (its docstring says why), and a mirror with no
  // cross-check cannot tell a genuine drift apart from an intentional
  // change on either side -- this suite and `test_render_demo_edge.py`'s
  // own `CrossCheckAgainstSlotPortsTsTests` are both asserted against the
  // same `slot-ports.golden.json`, so either formula drifting from that
  // shared fixture fails that side's own test. (A formula drifting on
  // both sides in the same wrong direction is the one shape this pair
  // cannot catch -- accepted, since neither file reads the other's
  // source.)
  describe('cross-checked against demo-host/provision/render_demo_edge.py, via slot-ports.golden.json', () => {
    let golden: GoldenPorts;

    it("the golden fixture uses this file's own default bases", async () => {
      golden = JSON.parse(await readFile(GOLDEN_PORTS_PATH, 'utf8')) as GoldenPorts;
      expect(golden.appPortBase).toBe(9300);
      expect(golden.healthPortBase).toBe(9100);
      expect(golden.slots).toHaveLength(7);
    });

    it("every slot's app and health ports match the golden fixture", async () => {
      golden = JSON.parse(await readFile(GOLDEN_PORTS_PATH, 'utf8')) as GoldenPorts;
      for (const entry of golden.slots) {
        const slot = entry.slot as SlotName;
        expect(slotPort(golden.appPortBase, slot, 'a')).toBe(entry.a);
        expect(slotPort(golden.appPortBase, slot, 'b')).toBe(entry.b);
        expect(slotHealthPort(golden.healthPortBase, slot)).toBe(entry.health);
      }
    });
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
