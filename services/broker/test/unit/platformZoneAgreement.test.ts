import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FieldValidationError,
  validateTenantStack,
  type TenantStackDescriptor,
} from '@branchleft/ghost-platform-render-core';
import { describe, expect, it } from 'vitest';
import { zonesFromEnv } from '../../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = join(HERE, '../../systemd/broker.env.example');
const DEMO_TENANT_DESCRIPTOR = join(
  HERE,
  '../../../../render-core/test/demo-tenant/demo-tenant.descriptor.json'
);

/**
 * The platform zone is held in two places that are written separately: the
 * broker's env template (`BROKER_PLATFORM_ZONE`) and render-core's
 * demo-tenant descriptor, whose `siteUrl` is `https://<slug>.<platformZone>`
 * and is pinned by that tenant's goldens. A broker started from the template
 * promotes a demo to `<sub>.<its zone>`, so the two must name the same zone.
 * The check is render-core's own: the template's zones go through
 * `validateTenantStack`, which refuses a `siteUrl` outside the platform zone.
 */
function envFileValues(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function demoTenant(): TenantStackDescriptor {
  return JSON.parse(readFileSync(DEMO_TENANT_DESCRIPTOR, 'utf8')) as TenantStackDescriptor;
}

/** The refusal field when render-core rejects the descriptor under the zones, else null. */
function refusedField(zones: ReturnType<typeof zonesFromEnv>): string | null {
  try {
    validateTenantStack(demoTenant(), zones);
    return null;
  } catch (error) {
    if (error instanceof FieldValidationError) return error.field;
    throw error;
  }
}

describe("the broker's platform zone is render-core's platform zone", () => {
  it('broker.env.example names the zone the demo-tenant descriptor renders under', () => {
    const zones = zonesFromEnv(envFileValues(ENV_EXAMPLE));
    expect(refusedField(zones)).toBeNull();
  });

  it('a different broker platform zone is refused by render-core (sabotage)', () => {
    const zones = zonesFromEnv(envFileValues(ENV_EXAMPLE));
    expect(refusedField({ ...zones, platformZone: 'publicpress.co.uk' })).toBe('siteUrl');
  });
});
