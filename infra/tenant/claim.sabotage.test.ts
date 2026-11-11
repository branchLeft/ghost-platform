/**
 * Sabotage for the tenant-name claim: the control that stops a
 * template-generated duplicate of tenant zero. Each test imports a copy of
 * the real naming.ts with the claim comparison deleted (RED: the duplicate is
 * accepted) and then the real module (GREEN: it is refused).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupSabotageTmp, importSabotaged } from './test/sabotage';
import { validateTenantNameClaim } from './naming';

afterAll(() => {
  cleanupSabotageTmp();
});

const DUPLICATE_REPO = 'branchLeft/ghost-tenant-someone-else';

type Naming = { validateTenantNameClaim: typeof validateTenantNameClaim };

describe('tenant-name claim: source-mutation sabotage', () => {
  it('a claim check with the repository comparison removed accepts the duplicate; the real one refuses it', async () => {
    const target =
      'if (claimantRepo === undefined || claimantRepo.toLowerCase() !== entry.repo.toLowerCase()) {';
    const sabotaged = await importSabotaged<Naming>('naming.ts', (source) => {
      if (!source.includes(target)) {
        throw new Error('sabotage target not found in naming.ts; update the mutation');
      }
      return source.replace(target, 'if (false) {');
    });
    // RED: with the comparison gone, a duplicate `blog` from another repo is accepted.
    expect(() => sabotaged.validateTenantNameClaim('blog', DUPLICATE_REPO)).not.toThrow();
    expect(() => sabotaged.validateTenantNameClaim('blog', undefined)).not.toThrow();
    // GREEN: the real module refuses both.
    expect(() => validateTenantNameClaim('blog', DUPLICATE_REPO)).toThrow(/registered to/);
    expect(() => validateTenantNameClaim('blog', undefined)).toThrow(/registered to/);
  });

  it('a claim check that ignores the register accepts the duplicate; the real one refuses it', async () => {
    const target = 'TENANT_NAMES.find((candidate) => candidate.name === slug)';
    const sabotaged = await importSabotaged<Naming>('naming.ts', (source) => {
      if (!source.includes(target)) {
        throw new Error('sabotage target not found in naming.ts; update the mutation');
      }
      return source.replace(target, 'undefined');
    });
    expect(() => sabotaged.validateTenantNameClaim('blog', DUPLICATE_REPO)).not.toThrow();
    expect(() => validateTenantNameClaim('blog', DUPLICATE_REPO)).toThrow(/registered to/);
  });
});
