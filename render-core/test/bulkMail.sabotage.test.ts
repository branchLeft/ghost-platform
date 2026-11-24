/**
 * Source-mutation sabotage for `mail.bulk`: each mutated copy of the real
 * `environment.ts` must be caught by the same assertion that passes against
 * the real module. The two halves of the control are the endpoint a tenant
 * names and the default a tenant naming none keeps.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { BulkMailSpec } from '../src/descriptor.js';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import { tenantEnvironment } from '../src/environment.js';
import { secretsEnvPath } from '../src/naming.js';
import { uploadLimits } from '../src/runtime.js';
import { MAIL_SPOOL_BASE_URL } from '../src/spool.js';
import { entryTenantDescriptor, TEST_ZONES } from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const BULK: BulkMailSpec = {
  endpoint: 'https://bulk.endpoint.example',
  domain: 'news.entry-co.example',
  credentialRef: 'GHOST_BULK_SUBMISSION_KEY',
};

const withoutBulk = entryTenantDescriptor();
const withBulk = { ...withoutBulk, mail: { ...withoutBulk.mail, bulk: BULK } };

function envOf(
  fn: typeof TenantEnvironmentFn,
  descriptor: typeof withoutBulk
): Record<string, string | number | boolean> {
  return fn(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_ZONES);
}

async function sabotaged(target: string, replacement: string) {
  return importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
    'environment.ts',
    (source) => {
      if (!source.includes(target)) {
        throw new Error(
          'sabotage target string not found in environment.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(target, replacement);
    }
  );
}

describe('BULK-ENDPOINT — source-mutation sabotage', () => {
  it('an environment.ts that ignores mail.bulk.endpoint keeps the spool; the real module renders the endpoint', async () => {
    const red = await sabotaged(
      'mail.bulk?.endpoint ?? MAIL_SPOOL_BASE_URL',
      'MAIL_SPOOL_BASE_URL'
    );
    expect(envOf(red.tenantEnvironment, withBulk).bulkEmail__mailgun__baseUrl).toBe(
      MAIL_SPOOL_BASE_URL
    );
    expect(envOf(tenantEnvironment, withBulk).bulkEmail__mailgun__baseUrl).toBe(BULK.endpoint);
  });

  it('an environment.ts that ignores mail.bulk.credentialRef reads the spool key; the real module reads the named key', async () => {
    const red = await sabotaged(
      'bulkCredentialKeyOf(descriptor.mail),\n      secretsFilePath',
      'SECRET_ENV_KEYS.bulkEmailApiKey,\n      secretsFilePath'
    );
    expect(String(envOf(red.tenantEnvironment, withBulk).bulkEmail__mailgun__apiKey)).toContain(
      'GHOST_BULK_EMAIL_API_KEY'
    );
    expect(String(envOf(tenantEnvironment, withBulk).bulkEmail__mailgun__apiKey)).toContain(
      BULK.credentialRef
    );
  });

  it('an environment.ts that changes the default for a tenant with no bulk setting is caught; the real module keeps the spool', async () => {
    const red = await sabotaged(
      'mail.bulk?.endpoint ?? MAIL_SPOOL_BASE_URL',
      "mail.bulk?.endpoint ?? 'https://changed.example'"
    );
    expect(envOf(red.tenantEnvironment, withoutBulk).bulkEmail__mailgun__baseUrl).not.toBe(
      MAIL_SPOOL_BASE_URL
    );
    expect(envOf(tenantEnvironment, withoutBulk).bulkEmail__mailgun__baseUrl).toBe(
      MAIL_SPOOL_BASE_URL
    );
  });
});
