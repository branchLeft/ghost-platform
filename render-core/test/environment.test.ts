/**
 * `tenantEnvironment()`'s break-glass and verdict-source keys, in isolation from the rest of
 * `render()`'s seven artefacts (those are pinned by `render.test.ts`'s
 * golden files, none of which carry `breakGlass.kind = "enabled"` — see
 * `fixtures.ts`).
 */
import { describe, expect, it } from 'vitest';
import { tenantEnvironment } from '../src/environment.js';
import { uploadLimits } from '../src/runtime.js';
import { secretsEnvPath } from '../src/naming.js';
import {
  breakGlassEnabled,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
  TEST_ZONES,
} from './fixtures.js';

const LIMITS = uploadLimits();

function env(descriptor: ReturnType<typeof tenantDescriptor>) {
  return tenantEnvironment(descriptor, LIMITS, secretsEnvPath(descriptor.slug), TEST_ZONES);
}

describe('tenantEnvironment() — breakGlass', () => {
  it('renders no adapters__sso__* key at all when breakGlass is disabled', () => {
    const rendered = env(tenantDescriptor());
    for (const key of Object.keys(rendered)) {
      expect(key.startsWith('adapters__sso__')).toBe(false);
    }
  });

  it('renders the active flag and all three configured values when enabled', () => {
    const descriptor = { ...tenantDescriptor(), breakGlass: breakGlassEnabled('acme') };
    const rendered = env(descriptor);
    expect(rendered.adapters__sso__active).toBe('BreakGlassSSO');
    expect(rendered.adapters__sso__BreakGlassSSO__publicKey).toBe(
      breakGlassEnabled('acme').publicKey
    );
    expect(rendered.adapters__sso__BreakGlassSSO__tenant).toBe('acme');
    expect(rendered.adapters__sso__BreakGlassSSO__supportIdentity).toBe('support@branchleft.co.uk');
  });

  it('escapes a literal "$" in a break-glass value the same way every other env value is escaped', () => {
    const descriptor = {
      ...tenantDescriptor(),
      breakGlass: { ...breakGlassEnabled('acme'), publicKey: 'abc$def' },
    };
    const rendered = env(descriptor);
    expect(rendered.adapters__sso__BreakGlassSSO__publicKey).toBe('abc$$def');
  });
});

// The scanning decorator refuses every upload unless a verdict source is
// named, and the only one it knows is an in-process fake that scans nothing.
// No render may name it: a demo is where the scan matters most, and a paying
// tenant has no real source wired yet either, so both refuse uploads.
describe('tenantEnvironment() — verdictSource', () => {
  const FEATURES = ['images', 'media', 'files'] as const;

  it.each([
    ['demo (local media)', demoDescriptor],
    ['entry tenant (object storage)', entryTenantDescriptor],
    ['professional tenant (object storage)', professionalTenantDescriptor],
  ] as const)('a %s renders the decorator and no verdict source', (_label, fixture) => {
    const rendered = env(fixture());
    for (const feature of FEATURES) {
      expect(rendered[`storage__${feature}__adapter`]).toBe('ScanningStorageAdapter');
      expect(rendered).not.toHaveProperty(`storage__${feature}__verdictSource`);
    }
    expect(Object.keys(rendered).filter((key) => /verdictsource/i.test(key))).toEqual([]);
    expect(Object.values(rendered)).not.toContain('in-process-fake');
  });
});

// The Network tab is ActivityPub's surface, and no federation service exists
// to back it. Ghost reads this flag from config only, so it must reach every
// kind of tenant as environment, whatever the member and staff caps are.
describe('tenantEnvironment() — social web lock', () => {
  it.each([
    ['demo', demoDescriptor],
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)('locks the ActivityPub setting for a %s', (_label, fixture) => {
    expect(env(fixture()).hostSettings__limits__limitSocialWeb__disabled).toBe(true);
  });

  it('locks it when every cap is null, so the lock is not a side effect of a cap', () => {
    const base = tenantDescriptor();
    const descriptor = {
      ...base,
      limits: { ...base.limits, membersCap: null, staffCap: null },
    };
    expect(env(descriptor).hostSettings__limits__limitSocialWeb__disabled).toBe(true);
  });
});
