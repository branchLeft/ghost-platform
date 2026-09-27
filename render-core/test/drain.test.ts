import { describe, expect, it } from 'vitest';
import { renderDrainList } from '../src/drain.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';
import { validate } from '../src/validate.js';
import type { TenantDescriptor } from '../src/descriptor.js';

function withHost(descriptor: TenantDescriptor, appHostIp: string): TenantDescriptor {
  return { ...descriptor, appHostIp: appHostIp as TenantDescriptor['appHostIp'] };
}

describe('renderDrainList() — exactly the mail-enabled hosts among the descriptors given', () => {
  it("contains each mail-enabled descriptor's own appHostIp", () => {
    const demo = validate(withHost(demoDescriptor(), '10.20.1.50'), TEST_ZONES);
    const entry = validate(withHost(entryTenantDescriptor(), '10.20.2.20'), TEST_ZONES);
    expect(renderDrainList([demo, entry])).toEqual(['10.20.1.50', '10.20.2.20']);
  });

  it('deduplicates two descriptors that share one host', () => {
    const a = validate(withHost(demoDescriptor(), '10.20.1.50'), TEST_ZONES);
    const b = validate(withHost(professionalTenantDescriptor(), '10.20.1.50'), TEST_ZONES);
    expect(renderDrainList([a, b])).toEqual(['10.20.1.50']);
  });

  it('excludes a descriptor whose mail is disabled', () => {
    const enabled = validate(withHost(demoDescriptor(), '10.20.1.50'), TEST_ZONES);
    const disabledBase = withHost(entryTenantDescriptor(), '10.20.2.20');
    const disabled: TenantDescriptor = {
      ...disabledBase,
      mail: { ...disabledBase.mail, enabled: false },
    };
    expect(renderDrainList([enabled, disabled])).toEqual(['10.20.1.50']);
  });

  it('returns an empty list for an empty fleet — the control case (an always-truthy predicate could pass with none of this)', () => {
    expect(renderDrainList([])).toEqual([]);
  });

  it('sorts the result for a deterministic diff', () => {
    const a = validate(withHost(demoDescriptor(), '10.20.2.99'), TEST_ZONES);
    const b = validate(withHost(entryTenantDescriptor(), '10.20.1.1'), TEST_ZONES);
    expect(renderDrainList([a, b])).toEqual(['10.20.1.1', '10.20.2.99']);
  });

  it('sabotage: a host absent from every given descriptor must never appear — RED reproduces a hardcoded extra host, GREEN is the real function', () => {
    const demo = validate(withHost(demoDescriptor(), '10.20.1.50'), TEST_ZONES);
    const real = renderDrainList([demo]);

    // RED (what a hardcoded/leaked-state implementation would produce): a
    // host nothing in the input named, appended anyway.
    const sabotaged = [...real, '203.0.113.99'];
    expect(sabotaged).toContain('203.0.113.99');

    // GREEN: the real function derives its output from the given
    // descriptors alone — a host none of them name is never present.
    expect(real).not.toContain('203.0.113.99');
    expect(real).toEqual(['10.20.1.50']);
  });
});
