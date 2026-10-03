import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import {
  desiredState,
  OWNER_ORG_NAME,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
  tenantOrgName,
} from '../src/desired.js';
import { managementClient } from '../src/management.js';
import { reconcile } from '../src/reconcile.js';

const url = process.env['ZITADEL_URL'];
const tokenFile = process.env['ZITADEL_TOKEN_FILE'];
if (!url || !tokenFile) {
  throw new Error('run through local/prove.sh: it supplies ZITADEL_URL and ZITADEL_TOKEN_FILE');
}

const client = managementClient({
  baseUrl: url,
  token: () => readFileSync(tokenFile, 'utf8').trim(),
  fetch: (target, init) => fetch(target, init),
});

const config = validateConfig({
  hostnames: {
    console: 'console.proof.test',
    portal: 'portal.proof.test',
    identity: 'id.proof.test',
  },
  tenants: [
    { slug: 'alpha', displayName: 'ALPHA' },
    { slug: 'beta', displayName: 'BETA' },
  ],
});

describe('against a real Zitadel', () => {
  it('creates two tenant organisations, and a second run changes nothing', async () => {
    const first = await reconcile(client, desiredState(config));
    expect(first.drift).toBe(false);
    expect(
      first.actions.filter((a) => a.kind === 'organisation' && a.status === 'created')
    ).toHaveLength(2 + 1);

    const second = await reconcile(client, desiredState(config));
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
    expect(second.outputs).toEqual(first.outputs);
  });

  it('holds two distinct clients and gives each tenant the tenant role only', async () => {
    const { outputs } = await reconcile(client, desiredState(config));
    expect(outputs.clientIds.console).not.toBe(outputs.clientIds.portal);
    expect(outputs.tenantOrgIds['alpha']).not.toBe(outputs.tenantOrgIds['beta']);
    expect((await client.findOrg(OWNER_ORG_NAME))?.id).toBe(outputs.ownerOrgId);
    expect((await client.findOrg(tenantOrgName('alpha')))?.id).toBe(outputs.tenantOrgIds['alpha']);
    for (const org of Object.values(outputs.tenantOrgIds)) {
      const grant = await client.findGrant(outputs.ownerOrgId, outputs.projectId, org);
      expect(grant?.roleKeys).toEqual([ROLE_TENANT_ADMIN]);
      expect(grant?.roleKeys).not.toContain(ROLE_OWNER);
    }
    const consoleApp = await client.findApplication(
      outputs.ownerOrgId,
      outputs.projectId,
      'owner-console'
    );
    const portalApp = await client.findApplication(
      outputs.ownerOrgId,
      outputs.projectId,
      'tenant-portal'
    );
    expect(consoleApp?.redirectUris).toEqual(['https://console.proof.test/auth/callback']);
    expect(portalApp?.redirectUris).toEqual(['https://portal.proof.test/auth/callback']);
  });
});
