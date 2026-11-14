import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindTenant } from 'ghost-platform-portal-data/tenant';
import * as real from '../src/tenant/demoScreen.js';
import {
  ambientRequestUrl,
  CREDENTIAL_A,
  CREDENTIAL_B,
  settingsFor,
  startApi,
  type RunningApi,
} from './provisioningRig.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

type DemoScreenModule = typeof real;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SOURCE = 'tenant/demoScreen.ts';

/** The one line that names the tenant a read is made for. */
const TENANT_READ = 'path: { tenant: scope.tenantId },';
const NAMED_BY_REQUEST =
  "new URL((await import('../provisioningRig.js')).ambientRequestUrl.getStore() ?? '/', 'http://request.invalid').searchParams.get('tenant')";
const SCOPE_PARAMETER = '  scope: TenantScope\n): Promise<DemoReading> {';
/** A screen that takes the demo to read from the request's query string, and the credential with it. */
const SCOPE_FROM_QUERY = `  bound: TenantScope\n): Promise<DemoReading> {\n  const scope = { tenantId: ${NAMED_BY_REQUEST} ?? bound.tenantId } as TenantScope;`;
/** The same, naming the demo in the path but still presenting the bound tenant's credential. */
const PATH_FROM_QUERY = `path: { tenant: ${NAMED_BY_REQUEST} ?? scope.tenantId },`;

let api: RunningApi;

beforeAll(async () => {
  api = await startApi(TENANT_A, TENANT_B, [TENANT_A, TENANT_B]);
});

afterAll(async () => {
  await api.close();
  clearMutants();
});

/**
 * What tenant A, signed in, is shown when the request in flight asks for
 * tenant B's demo by query string. The page function is the one the portal
 * registers; the request is made ambient only for a screen that reaches for it.
 */
async function whatAIsShown(module: DemoScreenModule): Promise<string> {
  const settings = settingsFor(api.baseUrl, {
    [TENANT_A]: CREDENTIAL_A,
    [TENANT_B]: CREDENTIAL_B,
  });
  const page = module.createDemoRoutes(settings).pages['/demo'];
  if (page === undefined) throw new Error('no /demo page');
  return ambientRequestUrl.run(`/demo?tenant=${TENANT_B}`, () => page(bindTenant(TENANT_A)));
}

describe('the demo screen takes its tenant from the bound scope alone', () => {
  it("shows A's demo, and not B's, when the request asks for B", async () => {
    const shown = await whatAIsShown(real);
    expect(shown).toContain(api.mock.store.getDemo(TENANT_A)?.address);
    expect(shown).not.toContain(api.mock.store.getDemo(TENANT_B)?.address);
  });

  it("is red for a screen that reads its demo from the query string: it shows B's", async () => {
    const mutant = await importSabotaged<DemoScreenModule>(
      'demoScreenFromQuery',
      SCOPE_PARAMETER,
      SCOPE_FROM_QUERY,
      SOURCE
    );
    const shown = await whatAIsShown(mutant);
    expect(shown).toContain(api.mock.store.getDemo(TENANT_B)?.address);
    expect(shown).not.toContain(api.mock.store.getDemo(TENANT_A)?.address);
  });

  it("is refused by the API itself when only the path names B: A's credential opens nothing of B's", async () => {
    const mutant = await importSabotaged<DemoScreenModule>(
      'demoScreenPathFromQuery',
      TENANT_READ,
      PATH_FROM_QUERY,
      SOURCE
    );
    await expect(whatAIsShown(mutant)).rejects.toMatchObject({ name: 'DemoReadError' });
  });
});
