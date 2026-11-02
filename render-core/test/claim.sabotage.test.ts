/**
 * Sabotage for the registered-name claim in `validateSlugAvailability`: each
 * test imports a copy of the real naming.ts with the claim mechanism removed
 * (RED: a duplicate of tenant zero, or a demo slugged `blog`, is accepted)
 * and then the real module (GREEN: both are refused).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Slug } from '../src/brand.js';
import { validateSlugAvailability } from '../src/naming.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const DUPLICATE_REPO = 'branchLeft/ghost-tenant-someone-else';
const blog = 'blog' as Slug;

type Naming = { validateSlugAvailability: typeof validateSlugAvailability };

async function sabotage(target: string, replacement: string): Promise<Naming> {
  return importSabotaged<Naming>('naming.ts', (source) => {
    if (!source.includes(target)) {
      throw new Error('sabotage target not found in naming.ts -- update the mutation');
    }
    return source.replace(target, replacement);
  });
}

describe('registered-name claim — source-mutation sabotage', () => {
  it('without the ownership test a duplicate of tenant zero and a demo are accepted; the real module refuses both', async () => {
    const naming = await sabotage('if (!owns) {', 'if (false) {');
    // RED
    expect(() =>
      naming.validateSlugAvailability(blog, { kind: 'tenant', repo: DUPLICATE_REPO })
    ).not.toThrow();
    expect(() => naming.validateSlugAvailability(blog, { kind: 'demo' })).not.toThrow();
    // GREEN
    expect(() => validateSlugAvailability(blog, { kind: 'tenant', repo: DUPLICATE_REPO })).toThrow(
      /registered to/
    );
    expect(() => validateSlugAvailability(blog, { kind: 'demo' })).toThrow(/registered to/);
  });

  it('if an undefined repository counted as a match, a run with no repository is accepted; the real module refuses it', async () => {
    const naming = await sabotage(
      'claimant.repo !== undefined &&\n    claimant.repo.toLowerCase() === entry.repo.toLowerCase();',
      '(claimant.repo ?? entry.repo).toLowerCase() === entry.repo.toLowerCase();'
    );
    // RED
    expect(() =>
      naming.validateSlugAvailability(blog, { kind: 'tenant', repo: undefined })
    ).not.toThrow();
    // GREEN
    expect(() => validateSlugAvailability(blog, { kind: 'tenant', repo: undefined })).toThrow(
      /registered to/
    );
  });
});
