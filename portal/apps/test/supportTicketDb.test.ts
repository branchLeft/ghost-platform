import { afterAll, beforeAll } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createFixture, TENANT_A, TENANT_B, type Fixture } from '../../data/test/helpers.js';
import { defineSupportRouteTests, VERSION_A, VERSION_B } from './supportRouteScenarios.js';

// The same route behaviour as supportRoutes.test.ts, against the real tenant
// data layer: the scope, the register row and the health reading come from
// row-level-isolated tables.
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
  const owner = new OwnerDb(fixture.owner);
  await owner.recordReading(
    TENANT_A,
    [
      `drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="${VERSION_A}"} 1\ndrain_sidecar_version_match 1`,
    ],
    new Date('2026-10-01T10:00:00Z')
  );
  await owner.recordReading(
    TENANT_B,
    [
      `drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="${VERSION_B}"} 1\ndrain_sidecar_version_match 0`,
    ],
    new Date('2026-10-02T10:00:00Z')
  );
});

afterAll(async () => {
  await fixture.close();
});

defineSupportRouteTests(() => new TenantDb(fixture.tenant));
