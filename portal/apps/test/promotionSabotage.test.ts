import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindTenant } from 'ghost-platform-portal-data/tenant';
import { TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import {
  createEssentialsRoutes,
  type KindReader,
  type RouteSet,
} from '../src/tenant/essentialsRoutes.js';
import type { ProvisioningSettings } from '../src/tenant/provisioningSettings.js';
import { settingsFor, startMock, type RunningMock } from './promotionRig.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

interface EssentialsModule {
  readonly createEssentialsRoutes: (
    settings: ProvisioningSettings | undefined,
    reader: KindReader
  ) => RouteSet;
}
type CreateRoutes = EssentialsModule['createEssentialsRoutes'];

const FILE = 'tenant/essentialsRoutes.ts';
const SEND = '/essentials/request';

let api: RunningMock;

beforeAll(clearMutants);
afterAll(clearMutants);

// A fresh API for each case: a tenant has one open request at a time, so a request made by an earlier case would hide a later one.
beforeEach(async () => {
  api = await startMock();
});

afterEach(async () => {
  await api.close();
});

const demo: KindReader = { ownKind: async () => 'DEMO' };
const real: KindReader = { ownKind: async () => 'REAL' };

/**
 * Tenant B signs in and its form carries tenant A's id in every field a
 * handler might read it from. Returns who the API now holds a request for.
 */
async function postAsBNamingA(create: CreateRoutes): Promise<string[]> {
  const before = api.mock.store.listRequests(undefined).length;
  const routes = create(settingsFor(api.baseUrl), demo);
  const act = routes.actions[SEND];
  if (act === undefined) throw new Error('the action is not registered');
  await act(
    bindTenant(TENANT_B),
    { subject: 'user-1' },
    new URLSearchParams({ tenant: TENANT_A, tenant_id: TENANT_A })
  );
  return api.mock.store
    .listRequests(undefined)
    .slice(before)
    .map((request) => request.tenant_id);
}

describe('sabotage: the tenant comes from the bound scope and from nothing the request carries', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(
      importSabotaged('noop', 'text that is not in the module', 'x', FILE)
    ).rejects.toThrow('exactly once');
  });

  it('RED: a handler that reads the tenant from a form field files the request under another tenant', async () => {
    const broken = await importSabotaged<EssentialsModule>(
      'tenant-from-form',
      '[ESSENTIALS_SEND_PATH]: async (scope) => {\n      const tenant = scope.tenantId;',
      "[ESSENTIALS_SEND_PATH]: async (scope, _identity, form) => {\n      const tenant = form.get('tenant') ?? scope.tenantId;",
      FILE
    );
    expect(await postAsBNamingA(broken.createEssentialsRoutes)).toEqual([TENANT_A]);
  });

  it('GREEN: the real module files it under the signed-in tenant alone', async () => {
    expect(await postAsBNamingA(createEssentialsRoutes)).toEqual([TENANT_B]);
  });
});

describe('sabotage: the kind check is what keeps a real tenant out of the promotion', () => {
  async function postAsReal(create: CreateRoutes): Promise<{ made: number; refused: boolean }> {
    const before = api.mock.store.listRequests(undefined).length;
    const act = create(settingsFor(api.baseUrl), real).actions[SEND];
    if (act === undefined) throw new Error('the action is not registered');
    let refused = false;
    try {
      await act(bindTenant(TENANT_A), { subject: 'user-1' }, new URLSearchParams());
    } catch {
      refused = true;
    }
    return { made: api.mock.store.listRequests(undefined).length - before, refused };
  }

  it('RED: without the check, a real tenant asks to be promoted and the API records it', async () => {
    const broken = await importSabotaged<EssentialsModule>(
      'no-kind-check',
      "!== 'DEMO') throw",
      "=== 'NO_SUCH_KIND') throw",
      FILE
    );
    expect(await postAsReal(broken.createEssentialsRoutes)).toEqual({ made: 1, refused: false });
  });

  it('GREEN: the real module refuses it before the API is asked', async () => {
    expect(await postAsReal(createEssentialsRoutes)).toEqual({ made: 0, refused: true });
  });
});
