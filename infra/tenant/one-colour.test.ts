import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
import { installMocks } from './test/harness';
import { type ComposeDocument, ghostServices } from './test/composeServices';

/**
 * Mode A (branchLeft/workspace#3017): a tenant's rendered `compose.yml` never
 * carries two Ghost services, whatever options are set, because the generic
 * unit starts every service in the file. See index.md#one-colour-at-a-time.
 */

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

type Options = Record<string, unknown>;

function compose(label: string, options: Options): string {
  return new GhostTenant(`one-colour-${label}`, {
    descriptor: tenantZeroEquivalent(),
    zones: TEST_ZONES,
    ...options,
  }).composeFile;
}

const OPTION_SETS: [string, Options][] = [
  ['no options', {}],
  ['own-origin widgets', { widgets: 'own-origin' }],
  [
    'own-origin widgets, integrations left on',
    { widgets: 'own-origin', blockThirdPartyIntegrations: false },
  ],
  ['explicit maxUserConnections', { maxUserConnections: 25 }],
];

describe('GhostTenant renders exactly one Ghost service', () => {
  it.each(OPTION_SETS)('%s: colour a by default, never both', (label, options) => {
    const services = ghostServices(compose(`default-${label}`, options));
    expect(services.map((s) => s.name)).toEqual(['ghost-a']);
    expect(services[0]?.ports).toEqual(['10.20.1.100:8101:2368']);
  });

  it.each(OPTION_SETS)(
    '%s: activeColour b renders ghost-b alone, on the second port',
    (label, options) => {
      const services = ghostServices(compose(`b-${label}`, { ...options, activeColour: 'b' }));
      expect(services.map((s) => s.name)).toEqual(['ghost-b']);
      expect(services[0]?.ports).toEqual(['10.20.1.100:8102:2368']);
    }
  );

  it('the idle colour is absent from the file, not parked behind a profile', () => {
    for (const activeColour of ['a', 'b'] as const) {
      const file = compose(`absent-${activeColour}`, { activeColour });
      expect(file).not.toContain('profiles');
      expect(file).not.toContain(`ghost-${activeColour === 'a' ? 'b' : 'a'}:`);
    }
  });

  it.each(['c', 'A', '', null, 1])('refuses an activeColour of %j', (bad) => {
    expect(() => compose('bad', { activeColour: bad })).toThrow();
  });

  it('a swap changes only the Ghost service port: colour b is colour a on the other port', () => {
    const a = load(compose('swap-a', { activeColour: 'a' })) as ComposeDocument;
    const b = load(compose('swap-b', { activeColour: 'b' })) as ComposeDocument;
    const { ports: _portsA, ...serviceA } = a.services['ghost-a'] ?? {};
    const { ports: _portsB, ...serviceB } = b.services['ghost-b'] ?? {};
    expect(serviceB).toEqual(serviceA);
    expect({ ...a, services: {} }).toEqual({ ...b, services: {} });
  });
});
