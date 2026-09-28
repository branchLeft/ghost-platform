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
import { importSabotaged } from './helpers/sourceSabotage.js';

// No `afterAll(cleanupSabotageTmp)` here: `importSabotaged` already removes
// its own temp file in a `finally` (see that helper's own doc comment), and
// `test/.sabotage-tmp/` is shared with `sourceMutation.sabotage.test.ts`,
// which runs concurrently in a separate vitest worker — a second caller
// deleting the whole shared directory raced the other file's in-flight
// write and produced a real, observed ENOENT. One owner of the whole-
// directory cleanup is enough.

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

  it('sabotage: a host absent from every given descriptor must never appear — real source mutation, RED then reverted to GREEN', async () => {
    const demo = validate(withHost(demoDescriptor(), '10.20.1.50'), TEST_ZONES);

    // RED: mutate drain.ts's actual return statement so it appends a
    // hardcoded host nothing in the input named — the same shape of defect
    // a hardcoded/leaked-state extra target would be, proven here against
    // this function's real source rather than a string built inside the
    // test.
    const sabotaged = await importSabotaged<{
      renderDrainList: typeof renderDrainList;
    }>('drain.ts', (source) => {
      const target = 'return [...hosts].sort();';
      if (!source.includes(target)) {
        throw new Error(
          'sabotage target string not found in drain.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(target, "return [...hosts, '203.0.113.99'].sort();");
    });
    const sabotagedResult = sabotaged.renderDrainList([demo]);
    expect(sabotagedResult).toContain('203.0.113.99');

    // GREEN: the real, unmutated module derives its output from the given
    // descriptors alone — a host none of them name is never present.
    const { renderDrainList: realRenderDrainList } = await import('../src/drain.js');
    const realResult = realRenderDrainList([demo]);
    expect(realResult).not.toContain('203.0.113.99');
    expect(realResult).toEqual(['10.20.1.50']);
  });
});
