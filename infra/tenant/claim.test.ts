import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantStackDescriptor } from '@branchleft/ghost-platform-render-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { mediaBucketName } from './media';
import * as naming from './naming';
import {
  RESERVED_STACK_NAMES,
  TENANT_NAMES,
  TENANT_NAME_REGISTER,
  validateTenantSlug,
} from './naming';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
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

describe("one claim implementation: render core's", () => {
  it('naming.ts no longer carries a claim function of its own', () => {
    expect(Object.keys(naming)).not.toContain('validateTenantNameClaim');
  });

  it('the package index no longer exports one either', async () => {
    const index = await import('./index.js');
    expect(Object.keys(index)).not.toContain('validateTenantNameClaim');
  });
});

describe('GhostTenant and the tenant-name claim', () => {
  it('refuses a template-generated duplicate of tenant zero (blog, another repo)', () => {
    vi.stubEnv('GITHUB_REPOSITORY', DUPLICATE_REPO);
    expect(() => buildBlog('duplicate')).toThrow(/registered to branchLeft\/ghost-tenant-blog/);
  });

  it('refuses a local run, where GITHUB_REPOSITORY is unset (fail closed)', () => {
    delete process.env['GITHUB_REPOSITORY'];
    expect(() => buildBlog('local-run')).toThrow(/registered to branchLeft\/ghost-tenant-blog/);
  });

  it('refuses a registered name when GITHUB_REPOSITORY is empty', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    expect(() => buildBlog('empty-repo')).toThrow(/registered to branchLeft\/ghost-tenant-blog/);
  });

  it('is not derived from the slug: a repository named for the slug is not enough', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'someone/ghost-tenant-blog');
    expect(() => buildBlog('look-alike')).toThrow(/registered to/);
  });

  it('compares the repository case-insensitively, as GitHub does', () => {
    vi.stubEnv('GITHUB_REPOSITORY', TENANT_ZERO_REPO.toLowerCase());
    expect(() => buildBlog('lower-case')).not.toThrow();
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
