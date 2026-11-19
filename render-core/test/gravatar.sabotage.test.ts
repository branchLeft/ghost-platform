/**
 * Source-mutation sabotage for the Gravatar switch: a mutated copy of the real
 * `environment.ts` that no longer renders `privacy__useGravatar=false` must be
 * caught by the same assertion that passes against the real module.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import { tenantEnvironment } from '../src/environment.js';
import { secretsEnvPath } from '../src/naming.js';
import { uploadLimits } from '../src/runtime.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';
import { tenantDescriptor, TEST_ZONES } from './fixtures.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const descriptor = tenantDescriptor();

function render(fn: typeof TenantEnvironmentFn): Record<string, string | number | boolean> {
  return fn(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_ZONES);
}

describe('GRAVATAR-OFF — source-mutation sabotage', () => {
  it('an environment.ts without the key renders no switch; the real module renders it off', async () => {
    // RED: remove the key from the actual source.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = '    privacy__useGravatar: false,\n';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '');
      }
    );
    expect(render(sabotaged.tenantEnvironment).privacy__useGravatar).toBeUndefined();

    // GREEN: the real, unmutated module renders it off.
    expect(render(tenantEnvironment).privacy__useGravatar).toBe(false);
  });
});
