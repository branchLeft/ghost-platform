/**
 * Source-mutation sabotage for the one-colour control. The control is the
 * component's default: with `activeColour` unset it must render colour a, not
 * the render core's both-colours document. RED: a copy of the real index.ts
 * that passes the argument through unchanged renders two Ghost services, which
 * the generic unit would start together. GREEN: the real component renders one.
 */
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
import { ghostServices } from './test/composeServices';
import { installMocks } from './test/harness';
import { cleanupSabotageTmp, importSabotaged } from './test/sabotage';

const DEFAULTED =
  'activeColour: args.activeColour === undefined ? DEFAULT_ACTIVE_COLOUR : args.activeColour,';

type Index = { GhostTenant: typeof GhostTenantClass };

function importIndexWith(replacement: string): Promise<Index> {
  const packageDir = dirname(join(__dirname, 'index.ts'));
  return importSabotaged<Index>('index.ts', (source) => {
    if (!source.includes(DEFAULTED)) {
      throw new Error('sabotage target not found in index.ts; update the mutation');
    }
    return source
      .replace(DEFAULTED, replacement)
      .replaceAll(/from '\.\/([a-z-]+)'/g, `from '${packageDir}/$1'`);
  });
}

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

afterAll(() => {
  cleanupSabotageTmp();
});

function names(Component: typeof GhostTenantClass, label: string): string[] {
  const tenant = new Component(label, { descriptor: tenantZeroEquivalent(), zones: TEST_ZONES });
  return ghostServices(tenant.composeFile).map((s) => s.name);
}

describe('one colour at a time: source-mutation sabotage', () => {
  it('a component that leaves the colour unset renders both Ghosts; the real one renders one', async () => {
    const sabotaged = await importIndexWith('activeColour: args.activeColour,');
    // RED: both services in one file, so one `up -d` starts both.
    expect(names(sabotaged.GhostTenant, 'sabotaged-default')).toEqual(['ghost-a', 'ghost-b']);
    // GREEN: the real component renders colour a alone.
    expect(names(GhostTenant, 'real-default')).toEqual(['ghost-a']);
  });
});
