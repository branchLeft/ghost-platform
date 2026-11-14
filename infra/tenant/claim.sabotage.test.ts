/**
 * Sabotage for the tenant-name claim: the control that stops a
 * template-generated duplicate of tenant zero. The claim rule lives in render
 * core; this package's whole part is the claimant it hands over, read from
 * `GITHUB_REPOSITORY` with no fallback. Each test imports a copy of the real
 * index.ts with that argument mutated (RED: the duplicate, or a local run, is
 * accepted) and then the real component (GREEN: it is refused).
 */
import { dirname, join } from 'node:path';
import type { TenantStackDescriptor } from '@branchleft/ghost-platform-render-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
import { installMocks } from './test/harness';
import { cleanupSabotageTmp, importSabotaged } from './test/sabotage';

const TENANT_ZERO_REPO = 'branchLeft/ghost-tenant-blog';
// A template-generated duplicate runs in a repository of its own.
const DUPLICATE_REPO = 'branchLeft/ghost-tenant-someone-else';

const CLAIMANT_ARGUMENT = "claimantRepo: process.env['GITHUB_REPOSITORY'],";

type Index = { GhostTenant: typeof GhostTenantClass };

/** The tenant-zero-equivalent fixture, renamed `blog` throughout. */
function descriptorNamedBlog(): TenantStackDescriptor {
  return JSON.parse(
    JSON.stringify(tenantZeroEquivalent()).replaceAll('zero', 'blog')
  ) as TenantStackDescriptor;
}

/** index.ts with its claimant argument replaced; relative imports made absolute for the copy. */
function importIndexWith(replacement: string): Promise<Index> {
  const packageDir = dirname(join(__dirname, 'index.ts'));
  return importSabotaged<Index>('index.ts', (source) => {
    if (!source.includes(CLAIMANT_ARGUMENT)) {
      throw new Error('sabotage target not found in index.ts; update the mutation');
    }
    return source
      .replace(CLAIMANT_ARGUMENT, replacement)
      .replaceAll(/from '\.\/([a-z-]+)'/g, `from '${packageDir}/$1'`);
  });
}

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupSabotageTmp();
});

function build(Component: typeof GhostTenantClass, name: string): GhostTenantClass {
  return new Component(name, { descriptor: descriptorNamedBlog(), zones: TEST_ZONES });
}

describe('tenant-name claim: source-mutation sabotage', () => {
  it('a claimant fixed to tenant zero accepts the duplicate; the real component refuses it', async () => {
    const sabotaged = await importIndexWith(`claimantRepo: '${TENANT_ZERO_REPO}',`);
    vi.stubEnv('GITHUB_REPOSITORY', DUPLICATE_REPO);
    // RED: with the claimant no longer read from the running repository, the duplicate builds.
    expect(() => build(sabotaged.GhostTenant, 'sabotaged-duplicate')).not.toThrow();
    // GREEN: the real component refuses it.
    expect(() => build(GhostTenant, 'real-duplicate')).toThrow(/registered to/);
  });

  it('a claimant with a fallback accepts a local run; the real component refuses it', async () => {
    const sabotaged = await importIndexWith(
      `claimantRepo: process.env['GITHUB_REPOSITORY'] ?? '${TENANT_ZERO_REPO}',`
    );
    delete process.env['GITHUB_REPOSITORY'];
    // RED: with a fallback to tenant zero's repository, an unset variable is accepted.
    expect(() => build(sabotaged.GhostTenant, 'sabotaged-local')).not.toThrow();
    // GREEN: the real component fails closed.
    expect(() => build(GhostTenant, 'real-local')).toThrow(/registered to/);
  });

  it('control: the real component accepts tenant zero from its own repository', () => {
    vi.stubEnv('GITHUB_REPOSITORY', TENANT_ZERO_REPO);
    expect(() => build(GhostTenant, 'real-tenant-zero')).not.toThrow();
  });
});
