import * as renderCore from '@branchleft/ghost-platform-render-core';
import type { TenantStackDescriptor } from '@branchleft/ghost-platform-render-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
import { installMocks } from './test/harness';

// The claimant handed to render core must be the repository Actions reports,
// not a constant: render core's refusal (or acceptance) is the only claim check.
const OTHER_REPO = 'branchLeft/ghost-tenant-someone-else';

vi.mock('@branchleft/ghost-platform-render-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@branchleft/ghost-platform-render-core')>();
  return { ...actual, validateTenantStack: vi.fn(actual.validateTenantStack) };
});

/** The tenant-zero-equivalent fixture, renamed `blog`: a registered name. */
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
  vi.mocked(renderCore.validateTenantStack).mockClear();
});

describe('the claimant passed to render core', () => {
  it('is GITHUB_REPOSITORY of the running repository, so another repository is refused', () => {
    vi.stubEnv('GITHUB_REPOSITORY', OTHER_REPO);
    expect(
      () =>
        new GhostTenant('claimant-other', {
          descriptor: descriptorNamedBlog(),
          zones: TEST_ZONES,
        })
    ).toThrow();
    expect(renderCore.validateTenantStack).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { claimantRepo: OTHER_REPO }
    );
  });
});
