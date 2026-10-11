import { describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { zReconcileRequest } from '../src/generated/zod.gen.js';
import { demoDescriptor, descriptorForSlot } from '../test/helpers/fixtures.js';

/**
 * The spec's request schema is now enforced at run time, in front of
 * render-core's own `validate()`. The two were written separately, so this
 * is the check that a descriptor the broker's own fixtures build (and
 * render-core accepts) is also one the spec describes -- the drift that
 * would otherwise show up as a valid reconcile answered 400.
 */
describe('the generated request schema agrees with render-core on the fixture descriptors', () => {
  it('accepts the default demo descriptor and the one built for every slot', () => {
    const slots = ['0', '1', '2', '3', '4', '5', '6'] as const;
    const accepted = [
      { slot: '0', descriptor: demoDescriptor() },
      ...slots.map((slot) => ({ slot, descriptor: descriptorForSlot(slot as SlotName) })),
    ];
    for (const body of accepted) {
      const verdict = zReconcileRequest.safeParse(body);
      expect(verdict.success, JSON.stringify(verdict.error?.issues)).toBe(true);
    }
  });

  it('refuses a descriptor of an unknown kind (the control case: the schema is not vacuous)', () => {
    const verdict = zReconcileRequest.safeParse({
      slot: '0',
      descriptor: { ...demoDescriptor(), kind: 'not-a-kind' },
    });
    expect(verdict.success).toBe(false);
  });
});
