import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantStackDescriptor } from '@branchleft/ghost-platform-render-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { mediaBucketName } from './media';
import {
  RESERVED_STACK_NAMES,
  TENANT_NAMES,
  TENANT_NAME_REGISTER,
  validateTenantNameClaim,
  validateTenantSlug,
} from './naming';
import { TEST_ZONES, tenantZeroEquivalent, tenantZeroSecrets } from './test/fixtures';
import { installMocks } from './test/harness';

const TENANT_ZERO_REPO = 'branchLeft/ghost-tenant-blog';
// A template-generated duplicate runs in a repository of its own.
const DUPLICATE_REPO = 'branchLeft/ghost-tenant-someone-else';

const register = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'registers', 'tenant-names.json'), 'utf-8')
) as { names: { name: string; kind: string; repo?: string }[] };

/** The tenant-zero-equivalent fixture, renamed `blog` throughout. */
function descriptorNamedBlog(): TenantStackDescriptor {
  return JSON.parse(
    JSON.stringify(tenantZeroEquivalent()).replaceAll('zero', 'blog')
  ) as TenantStackDescriptor;
}

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function buildBlog(name: string): GhostTenantClass {
  return new GhostTenant(name, {
    descriptor: descriptorNamedBlog(),
    zones: TEST_ZONES,
    secrets: tenantZeroSecrets(),
  });
}

describe('the generated register agrees with registers/tenant-names.json', () => {
  it('holds every name of the register file, in order, with the same kind and repo', () => {
    expect(TENANT_NAME_REGISTER.map((e) => ({ ...e }))).toEqual(register.names);
  });

  it('derives RESERVED_STACK_NAMES from the infrastructure entries, mail-spool included', () => {
    const infrastructure = register.names.filter((e) => e.kind === 'infrastructure');
    expect([...RESERVED_STACK_NAMES]).toEqual(infrastructure.map((e) => e.name));
    expect(RESERVED_STACK_NAMES).toContain('mail-spool');
    expect(RESERVED_STACK_NAMES).not.toContain('blog');
  });

  it('derives TENANT_NAMES from the tenant entries', () => {
    expect(TENANT_NAMES.map((e) => e.name)).toEqual(['blog']);
  });
});

describe('validateTenantNameClaim', () => {
  it('accepts a registered tenant name from its own repository', () => {
    expect(() => validateTenantNameClaim('blog', TENANT_ZERO_REPO)).not.toThrow();
  });

  it('compares the repository case-insensitively, as GitHub does', () => {
    expect(() => validateTenantNameClaim('blog', TENANT_ZERO_REPO.toLowerCase())).not.toThrow();
  });

  it('refuses a registered tenant name from any other repository', () => {
    expect(() => validateTenantNameClaim('blog', DUPLICATE_REPO)).toThrow(/registered to/);
  });

  it('refuses a registered tenant name when no repository is known', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    expect(() => validateTenantNameClaim('blog', '')).toThrow(/registered to/);
  });

  it('reads GITHUB_REPOSITORY when no repository is passed, and refuses when it is absent', () => {
    vi.stubEnv('GITHUB_REPOSITORY', TENANT_ZERO_REPO);
    expect(() => validateTenantNameClaim('blog')).not.toThrow();
    vi.stubEnv('GITHUB_REPOSITORY', DUPLICATE_REPO);
    expect(() => validateTenantNameClaim('blog')).toThrow(/registered to/);
    vi.unstubAllEnvs();
    delete process.env['GITHUB_REPOSITORY'];
    expect(() => validateTenantNameClaim('blog')).toThrow(/GITHUB_REPOSITORY is unset/);
  });

  it('control: an unregistered name passes from any repository, or none', () => {
    expect(() => validateTenantNameClaim('demo-1', DUPLICATE_REPO)).not.toThrow();
    expect(() => validateTenantNameClaim('demo-1', undefined)).not.toThrow();
  });

  it('is not derived from the slug: a repo named for the slug is not enough', () => {
    expect(() => validateTenantNameClaim('blog', 'someone/ghost-tenant-blog')).toThrow(
      /registered to/
    );
  });
});

describe('GhostTenant and the tenant-name claim', () => {
  it('refuses a template-generated duplicate of tenant zero (blog, another repo)', () => {
    vi.stubEnv('GITHUB_REPOSITORY', DUPLICATE_REPO);
    expect(() => buildBlog('duplicate')).toThrow(/registered to branchLeft\/ghost-tenant-blog/);
  });

  it('refuses a local run, where GITHUB_REPOSITORY is unset', () => {
    delete process.env['GITHUB_REPOSITORY'];
    expect(() => buildBlog('local-run')).toThrow(/GITHUB_REPOSITORY is unset/);
  });

  it("accepts tenant zero's own repository and constructs in full", async () => {
    vi.stubEnv('GITHUB_REPOSITORY', TENANT_ZERO_REPO);
    const tenant = buildBlog('tenant-zero');
    expect(tenant.composeFile).toContain('ghost-blog-content');
  });

  it('control: an unregistered name constructs with no repository at all', () => {
    delete process.env['GITHUB_REPOSITORY'];
    expect(
      () =>
        new GhostTenant('unregistered', {
          descriptor: tenantZeroEquivalent(),
          zones: TEST_ZONES,
          secrets: tenantZeroSecrets(),
        })
    ).not.toThrow();
  });
});

describe('tenant zero stays usable under the register', () => {
  it('validateTenantSlug does not refuse blog: the claim is a separate check', () => {
    expect(() => validateTenantSlug('blog')).not.toThrow();
  });

  it('derives the live media bucket for blog', () => {
    expect(mediaBucketName('blog')).toBe('branchleft-media-blog');
  });
});
