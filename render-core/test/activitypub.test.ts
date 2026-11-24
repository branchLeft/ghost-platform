import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import { federationEnvironment, federationOn } from '../src/environment.js';
import { render, renderSettings } from '../src/render.js';
import { validate } from '../src/validate.js';
import { TEST_ZONES, demoDescriptor, entryTenantDescriptor } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOCK = 'hostSettings__limits__limitSocialWeb__disabled';

function withFederation(
  base: TenantDescriptor,
  activitypub: TenantDescriptor['activitypub']
): TenantDescriptor {
  return { ...base, activitypub };
}

function artefactsOf(descriptor: TenantDescriptor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const artefact of render(validate(descriptor, TEST_ZONES), TEST_ZONES)) {
    out[artefact.path] = artefact.content;
  }
  return out;
}

describe('federation is off by default and off renders today exactly', () => {
  it('an absent field and an explicit off render byte-identical artefacts', () => {
    expect(artefactsOf(withFederation(entryTenantDescriptor(), { kind: 'off' }))).toEqual(
      artefactsOf(entryTenantDescriptor())
    );
  });

  it('the off render matches the committed entry-tenant goldens byte for byte', () => {
    const rendered = artefactsOf(withFederation(entryTenantDescriptor(), { kind: 'off' }));
    for (const path of ['compose.yml', 'ghost-settings.json']) {
      const golden = readFileSync(join(here, 'golden', `entry-tenant.${path}`), 'utf-8');
      expect(rendered[path]).toBe(golden);
    }
  });

  it('off locks the Network setting in environment and settings', () => {
    const descriptor = entryTenantDescriptor();
    expect(federationOn(descriptor)).toBe(false);
    expect(federationEnvironment(descriptor)).toEqual({ [LOCK]: true });
    expect(renderSettings(validate(descriptor, TEST_ZONES), TEST_ZONES).social_web).toBe(false);
  });
});

describe('federation on unlocks the Network setting for a tenant', () => {
  const on = withFederation(entryTenantDescriptor(), { kind: 'on' });

  it('drops the lock key from the environment and renders no lock anywhere', () => {
    expect(federationOn(on)).toBe(true);
    expect(federationEnvironment(on)).toEqual({});
    const compose = artefactsOf(on)['compose.yml'];
    expect(compose).toBeDefined();
    expect(compose).not.toContain(LOCK);
  });

  it('sets social_web true in the settings', () => {
    expect(renderSettings(validate(on, TEST_ZONES), TEST_ZONES).social_web).toBe(true);
  });
});

describe('federation refusals', () => {
  it('refuses a demo that says on, so no demo can render with federation', () => {
    const descriptor = withFederation(demoDescriptor(), { kind: 'on' });
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(
      /demo descriptor may not turn federation on/
    );
  });

  it('accepts a demo that says off, and a tenant that says on', () => {
    expect(() =>
      validate(withFederation(demoDescriptor(), { kind: 'off' }), TEST_ZONES)
    ).not.toThrow();
    expect(() =>
      validate(withFederation(entryTenantDescriptor(), { kind: 'on' }), TEST_ZONES)
    ).not.toThrow();
  });
});
