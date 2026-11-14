import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import * as real from '../src/tenant/site.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';
import {
  CREDENTIAL_A,
  CREDENTIAL_B,
  isolationOutcome,
  promote,
  settingsFor,
  startMock,
  type Isolation,
  type RunningMock,
} from './tenantSiteRig.js';

const SOURCE = 'tenant/site.ts';
/** The one place the page takes its tenant from. */
const FROM_THE_SCOPE = 'scope.tenantId';
/** The sabotage: the tenant named by a request's query string wins over the session's. */
const FROM_THE_QUERY =
  "((globalThis as Record<string, unknown>)['queryTenant'] as string | undefined) ?? scope.tenantId";

let running: RunningMock;

/** The isolation invariant, stated once for the real page and the sabotaged one. */
function assertIsolated(outcome: Isolation): void {
  expect(outcome.showsOwn).toBe(true);
  expect(outcome.showsOther).toBe(false);
}

async function outcomeOf(createRoutes: typeof real.createSiteRoutes): Promise<Isolation> {
  const hostnameOf = (tenant: string): string => {
    const hostname = running.mock.store.getTenant(tenant)?.hostnames[0];
    if (hostname === undefined) throw new Error('the mock gave the tenant no hostname');
    return hostname;
  };
  return isolationOutcome(
    createRoutes,
    settingsFor(running.baseUrl),
    { tenant: TENANT_A, hostname: hostnameOf(TENANT_A) },
    { tenant: TENANT_B, hostname: hostnameOf(TENANT_B) }
  );
}

beforeAll(async () => {
  running = await startMock();
  await promote(running, TENANT_A, CREDENTIAL_A);
  await promote(running, TENANT_B, CREDENTIAL_B);
});

afterAll(async () => {
  await running.close();
  clearMutants();
});

describe('the site screen takes its tenant from the bound scope alone', () => {
  it('shows tenant A only its own site while a request names tenant B', async () => {
    assertIsolated(await outcomeOf(real.createSiteRoutes));
  });

  it('fails the isolation check when the page reads the tenant from the query string', async () => {
    const mutant = await importSabotaged<typeof real>(
      'siteQueryTenant',
      FROM_THE_SCOPE,
      FROM_THE_QUERY,
      SOURCE
    );
    const outcome = await outcomeOf(mutant.createSiteRoutes);
    // Tenant B's site is on tenant A's page, and A's own is gone.
    expect(outcome).toEqual({ showsOwn: false, showsOther: true });
    expect(() => assertIsolated(outcome)).toThrow();
  });
});
