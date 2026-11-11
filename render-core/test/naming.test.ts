import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Slug } from '../src/brand.js';
import { FieldValidationError } from '../src/brand.js';
import type { Port } from '../src/brand.js';
import {
  MAX_TENANT_SLUG_LENGTH,
  RESERVED_STACK_NAMES,
  TENANT_NAME_REGISTER,
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  metricsVolumeName,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
  validateDatabaseIdentity,
  validateSlugAvailability,
} from '../src/naming.js';
import { MAIL_SPOOL_STACK } from '../src/spool.js';
import { render } from '../src/render.js';
import { validate, validateTenantStack } from '../src/validate.js';
import { TEST_ZONES, demoDescriptor, tenantDescriptor } from './fixtures.js';

const slug = 'my-tenant' as Slug;

describe('naming.ts', () => {
  it('sqlIdentifier replaces every hyphen with an underscore', () => {
    expect(sqlIdentifier(slug)).toBe('my_tenant');
  });

  it('databaseAndUserName prefixes the sql identifier', () => {
    expect(databaseAndUserName(slug)).toBe('ghost_my_tenant');
  });

  it('stackName is the slug itself', () => {
    expect(stackName(slug)).toBe('my-tenant');
  });

  it('stackDirectory is under /opt/branchleft', () => {
    expect(stackDirectory(slug)).toBe('/opt/branchleft/my-tenant');
  });

  it('composeUnitName is the systemd instance name', () => {
    expect(composeUnitName(slug)).toBe('branchleft-compose@my-tenant.service');
  });

  it('secretsEnvPath and imageEnvPath are distinct files under /etc/branchleft', () => {
    expect(secretsEnvPath(slug)).toBe('/etc/branchleft/my-tenant.env');
    expect(imageEnvPath(slug)).toBe('/etc/branchleft/my-tenant.image.env');
    expect(secretsEnvPath(slug)).not.toBe(imageEnvPath(slug));
  });

  it('content and adapters volumes are distinct, derived from the slug alone', () => {
    expect(contentVolumeName(slug)).toBe('ghost-my-tenant-content');
    expect(adaptersVolumeName(slug)).toBe('ghost-my-tenant-adapters');
    expect(contentVolumeName(slug)).not.toBe(adaptersVolumeName(slug));
  });

  it('the metrics volume is a third, slug-scoped name distinct from the other two', () => {
    expect(metricsVolumeName(slug)).toBe('ghost-my-tenant-metrics');
    expect(metricsVolumeName(slug)).not.toBe(contentVolumeName(slug));
    expect(metricsVolumeName(slug)).not.toBe(adaptersVolumeName(slug));
    expect(metricsVolumeName('other-tenant' as Slug)).not.toBe(metricsVolumeName(slug));
  });

  describe('validateSlugAvailability()', () => {
    it('accepts a non-reserved, short-enough slug (control case)', () => {
      expect(() => validateSlugAvailability(slug)).not.toThrow();
    });

    it.each(RESERVED_STACK_NAMES)('SABOTAGE — rejects the reserved name "%s"', (reserved) => {
      // RED: a reserved stack name must never validate as a tenant slug.
      expect(() => validateSlugAvailability(reserved as Slug)).toThrow(FieldValidationError);
      expect(() => validateSlugAvailability(reserved as Slug)).toThrow(/is reserved/);
      // GREEN: a slug that merely contains a reserved name is unaffected.
      expect(() => validateSlugAvailability(`${reserved}-2` as Slug)).not.toThrow();
    });

    it("SABOTAGE — rejects a slug too long for MySQL's 32-character account limit", () => {
      const tooLong = 'a'.repeat(MAX_TENANT_SLUG_LENGTH + 1) as Slug;
      const justRight = 'a'.repeat(MAX_TENANT_SLUG_LENGTH) as Slug;
      expect(() => validateSlugAvailability(tooLong)).toThrow(/at most/);
      expect(() => validateSlugAvailability(justRight)).not.toThrow();
    });
  });

  describe('validateDatabaseIdentity()', () => {
    const expected = databaseAndUserName(slug);

    it('accepts the slug-derived name and user', () => {
      expect(() =>
        validateDatabaseIdentity(slug, {
          kind: 'mysql',
          host: 'db1',
          port: 3306 as Port,
          name: expected,
          user: expected,
        })
      ).not.toThrow();
    });

    it('SABOTAGE — a foreign database name must never validate: red then green', () => {
      const foreign = {
        kind: 'mysql' as const,
        host: 'db1',
        port: 3306 as Port,
        name: 'ghost_someone_else',
        user: expected,
      };
      // RED: the same isolation hole `validateMediaBucket` closes for the
      // bucket, carried onto the database name by review.
      expect(() => validateDatabaseIdentity(slug, foreign)).toThrow(FieldValidationError);
      expect(() => validateDatabaseIdentity(slug, foreign)).toThrow(/must be "ghost_my_tenant"/);
      // GREEN: the slug's own name still validates.
      expect(() => validateDatabaseIdentity(slug, { ...foreign, name: expected })).not.toThrow();
    });

    it('SABOTAGE — a foreign database user must never validate: red then green', () => {
      const foreign = {
        kind: 'mysql' as const,
        host: 'db1',
        port: 3306 as Port,
        name: expected,
        user: 'ghost_someone_else',
      };
      expect(() => validateDatabaseIdentity(slug, foreign)).toThrow(FieldValidationError);
      expect(() => validateDatabaseIdentity(slug, { ...foreign, user: expected })).not.toThrow();
    });
  });
});

const TENANT_ZERO_REPO = 'branchLeft/ghost-tenant-blog';
// A template-generated duplicate runs in a repository of its own.
const DUPLICATE_REPO = 'branchLeft/ghost-tenant-someone-else';

function blogDescriptor() {
  const base = tenantDescriptor();
  return {
    ...base,
    slug: 'blog' as Slug,
    database: { ...base.database, name: 'ghost_blog', user: 'ghost_blog' },
    media: { ...base.media, bucket: 'branchleft-media-blog' },
  } as typeof base;
}

describe('the reserved list and tenant zero', () => {
  const EXPECTED_RESERVED = ['website', 'edge', 'db', 'monitoring', 'nextcloud1', 'mail-spool'];

  it('is exactly the expected names, with no tenant-zero slug in it', () => {
    expect([...RESERVED_STACK_NAMES].sort()).toEqual([...EXPECTED_RESERVED].sort());
    expect(RESERVED_STACK_NAMES).not.toContain('blog');
  });

  it('accepts the tenant-zero slug "blog" when no claimant is named (control case)', () => {
    expect(() => validateSlugAvailability('blog' as Slug)).not.toThrow();
  });

  it("validates and renders tenant zero's descriptor from tenant zero's own repository", () => {
    const validated = validate(blogDescriptor(), TEST_ZONES, { claimantRepo: TENANT_ZERO_REPO });
    const artefacts = render(validated, TEST_ZONES);
    expect(artefacts).toHaveLength(7);
    expect(artefacts.some((a) => a.content.includes('ghost-blog-content'))).toBe(true);
  });

  it.each(EXPECTED_RESERVED)('still refuses "%s" in validate() and render()', (reserved) => {
    const base = tenantDescriptor();
    const sql = reserved.replaceAll('-', '_');
    const bad = {
      ...base,
      slug: reserved as Slug,
      database: { ...base.database, name: `ghost_${sql}`, user: `ghost_${sql}` },
      media: { ...base.media, bucket: `branchleft-media-${reserved}` },
    } as typeof base;
    expect(() => validate(bad, TEST_ZONES)).toThrow(/is reserved/);
    expect(() => render(bad, TEST_ZONES)).toThrow(/is reserved/);
  });

  it("holds the spool's own stack name, so the two cannot disagree", () => {
    expect(RESERVED_STACK_NAMES).toContain(MAIL_SPOOL_STACK);
  });
});

describe('registered tenant names and the claimant', () => {
  it('refuses a registered tenant name to a demo', () => {
    expect(() => validateSlugAvailability('blog' as Slug, { kind: 'demo' })).toThrow(
      FieldValidationError
    );
    expect(() => validateSlugAvailability('blog' as Slug, { kind: 'demo' })).toThrow(
      /registered to branchLeft\/ghost-tenant-blog/
    );
  });

  it('refuses a registered tenant name to a tenant in another repository, or none', () => {
    const duplicate = { kind: 'tenant', repo: DUPLICATE_REPO } as const;
    expect(() => validateSlugAvailability('blog' as Slug, duplicate)).toThrow(/registered to/);
    expect(() =>
      validateSlugAvailability('blog' as Slug, { kind: 'tenant', repo: undefined })
    ).toThrow(/registered to/);
  });

  it("accepts a registered tenant name for that name's own repository, in any letter case", () => {
    for (const repo of [TENANT_ZERO_REPO, TENANT_ZERO_REPO.toLowerCase()]) {
      expect(() =>
        validateSlugAvailability('blog' as Slug, { kind: 'tenant', repo })
      ).not.toThrow();
    }
  });

  it('control: an unregistered slug is accepted for a demo and for any tenant repository', () => {
    expect(() => validateSlugAvailability('demo-1' as Slug, { kind: 'demo' })).not.toThrow();
    expect(() =>
      validateSlugAvailability('demo-1' as Slug, { kind: 'tenant', repo: DUPLICATE_REPO })
    ).not.toThrow();
  });

  it('control: infrastructure names are refused to every claimant, including the owner repo', () => {
    for (const claimant of [
      { kind: 'demo' },
      { kind: 'tenant', repo: TENANT_ZERO_REPO },
    ] as const) {
      expect(() => validateSlugAvailability('website' as Slug, claimant)).toThrow(/is reserved/);
    }
  });

  it('validate() refuses a demo descriptor slugged "blog" (the broker path)', () => {
    const demo = { ...demoDescriptor(), slug: 'blog' as Slug };
    expect(() => validate(demo, TEST_ZONES)).toThrow(/registered to/);
    // Control: the same descriptor under an unregistered slug validates.
    expect(() => validate(demoDescriptor(), TEST_ZONES)).not.toThrow();
  });

  it('validate() and validateTenantStack() refuse a duplicate of tenant zero', () => {
    expect(() => validate(blogDescriptor(), TEST_ZONES)).toThrow(/registered to/);
    expect(() => validate(blogDescriptor(), TEST_ZONES, { claimantRepo: DUPLICATE_REPO })).toThrow(
      /registered to/
    );
    const stack: Record<string, unknown> = { ...blogDescriptor() };
    delete stack['ownerEmail'];
    expect(() =>
      validateTenantStack(stack as never, TEST_ZONES, { claimantRepo: DUPLICATE_REPO })
    ).toThrow(/registered to/);
    expect(() =>
      validateTenantStack(stack as never, TEST_ZONES, { claimantRepo: TENANT_ZERO_REPO })
    ).not.toThrow();
  });
});

describe('agreement with registers/tenant-names.json', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '../..');
  const register = JSON.parse(
    readFileSync(join(repoRoot, 'registers/tenant-names.json'), 'utf-8')
  ) as { names: { name: string; kind: string; repo?: string }[] };

  it('holds every name of the register file, with the same kind and repo', () => {
    expect(TENANT_NAME_REGISTER.map((entry) => ({ ...entry }))).toEqual(register.names);
  });

  it('reserves exactly the infrastructure entries', () => {
    const infrastructure = register.names.filter((entry) => entry.kind === 'infrastructure');
    expect([...RESERVED_STACK_NAMES]).toEqual(infrastructure.map((entry) => entry.name));
  });

  it("carries the same generated block as infra/tenant's naming.ts", () => {
    const block = (path: string): string => {
      const text = readFileSync(join(repoRoot, path), 'utf-8');
      const start = text.indexOf('// BEGIN GENERATED FROM registers/tenant-names.json');
      const end = text.indexOf('// END GENERATED FROM registers/tenant-names.json');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(block('render-core/src/naming.ts')).toBe(block('infra/tenant/naming.ts'));
  });
});
