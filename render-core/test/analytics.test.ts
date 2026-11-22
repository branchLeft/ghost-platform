import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import { render } from '../src/render.js';
import { validate } from '../src/validate.js';
import { demoDescriptor, tenantDescriptor, TEST_ZONES } from './fixtures.js';

const SITE = '3f2b8c1e-5a4d-4b6e-9f70-1a2b3c4d5e6f';

function withAnalytics(
  base: TenantDescriptor,
  analytics: TenantDescriptor['analytics']
): TenantDescriptor {
  return { ...base, analytics };
}

function composeOf(descriptor: TenantDescriptor): string {
  const compose = render(descriptor, TEST_ZONES).find((a) => a.path === 'compose.yml');
  if (compose === undefined) throw new Error('no compose.yml');
  return compose.content;
}

function secretsOf(descriptor: TenantDescriptor): string {
  const secrets = render(descriptor, TEST_ZONES).find((a) => a.path === 'secrets.env');
  if (secrets === undefined) throw new Error('no secrets.env');
  return secrets.content;
}

const TINYBIRD_KEYS = [
  'tinybird__tracker__endpoint',
  'tinybird__workspaceId',
  'tinybird__stats__endpoint',
  'tinybird__stats__endpointBrowser',
  'tinybird__adminToken',
];

describe('analytics is off by default', () => {
  it('a descriptor with no analytics field renders no tinybird key and no signing-key secret', () => {
    const descriptor = tenantDescriptor();
    const compose = composeOf(descriptor);
    for (const key of TINYBIRD_KEYS) {
      expect(compose).not.toContain(key);
    }
    expect(secretsOf(descriptor)).not.toContain('GHOST_TINYBIRD_ADMIN_TOKEN');
  });

  it('an explicit off renders the same as an absent field', () => {
    const descriptor = withAnalytics(tenantDescriptor(), { kind: 'off' });
    expect(composeOf(descriptor)).not.toContain('tinybird__');
    expect(secretsOf(descriptor)).not.toContain('GHOST_TINYBIRD_ADMIN_TOKEN');
  });
});

describe('analytics on renders exactly the Ghost keys and places the signing key', () => {
  it('renders the five keys in each colour, with the signing key read from secrets', () => {
    const descriptor = withAnalytics(tenantDescriptor(), { kind: 'on', siteUuid: SITE });
    const compose = composeOf(descriptor);
    const base = descriptor.siteUrl.replace(/\/$/, '');
    expect(compose).toContain(
      `tinybird__tracker__endpoint: '${base}/.ghost/analytics/api/v1/page_hit'`
    );
    expect(compose).toContain(`tinybird__workspaceId: '${SITE}'`);
    expect(compose).toContain(`tinybird__stats__endpoint: '${base}/.ghost/analytics'`);
    expect(compose).toContain(`tinybird__stats__endpointBrowser: '${base}/.ghost/analytics'`);
    expect(compose).toContain('GHOST_TINYBIRD_ADMIN_TOKEN:?');
    expect(secretsOf(descriptor)).toContain('GHOST_TINYBIRD_ADMIN_TOKEN=');
    expect(secretsOf(descriptor)).toContain(`/etc/ghost-analytics/keys/${SITE}.key`);
  });

  it('never renders a key outside the five-key set, once per colour', () => {
    const descriptor = withAnalytics(tenantDescriptor(), { kind: 'on', siteUuid: SITE });
    const tinybirdLines = composeOf(descriptor)
      .split('\n')
      .filter((line) => line.includes('tinybird__'));
    // Two colours, five keys each.
    expect(tinybirdLines).toHaveLength(10);
  });
});

describe('analytics refusals', () => {
  it('refuses an upper-case site identifier', () => {
    const descriptor = withAnalytics(tenantDescriptor(), {
      kind: 'on',
      siteUuid: SITE.toUpperCase(),
    });
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(/lower-case UUID/);
  });

  it('refuses a demo with analytics on', () => {
    const descriptor = withAnalytics(demoDescriptor(), { kind: 'on', siteUuid: SITE });
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(/demo/);
  });

  it('accepts a lower-case site identifier on a tenant', () => {
    const descriptor = withAnalytics(tenantDescriptor(), { kind: 'on', siteUuid: SITE });
    expect(() => validate(descriptor, TEST_ZONES)).not.toThrow();
  });
});
