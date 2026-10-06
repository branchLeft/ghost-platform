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
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
  validateDatabaseIdentity,
  validateSlugAvailability,
} from '../src/naming.js';
import { MAIL_SPOOL_STACK } from '../src/spool.js';
import { render } from '../src/render.js';
import { validate } from '../src/validate.js';
import { TEST_ZONES, tenantDescriptor } from './fixtures.js';

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

describe('the reserved list and tenant zero', () => {
  const EXPECTED_RESERVED = ['website', 'edge', 'db', 'monitoring', 'nextcloud1', 'mail-spool'];

  it('is exactly the expected names, with no tenant-zero slug in it', () => {
    expect([...RESERVED_STACK_NAMES].sort()).toEqual([...EXPECTED_RESERVED].sort());
    expect(RESERVED_STACK_NAMES).not.toContain('blog');
  });

  it('accepts the tenant-zero slug "blog" (control case)', () => {
    expect(() => validateSlugAvailability('blog' as Slug)).not.toThrow();
  });

  it('validates and renders a descriptor slugged "blog"', () => {
    const base = tenantDescriptor();
    const blog = {
      ...base,
      slug: 'blog' as Slug,
      database: { ...base.database, name: 'ghost_blog', user: 'ghost_blog' },
      media: { ...base.media, bucket: 'branchleft-media-blog' },
    } as typeof base;
    const validated = validate(blog, TEST_ZONES);
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

describe('agreement with infra/tenant/naming.ts', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tenantSource = readFileSync(join(here, '../../infra/tenant/naming.ts'), 'utf-8');

  function tenantReserved(source: string): string[] {
    const body = /RESERVED_STACK_NAMES: readonly string\[\] = \[([^\]]*)\]/.exec(source)?.[1];
    if (body === undefined) throw new Error('infra/tenant RESERVED_STACK_NAMES not found');
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  }

  it("reserves infra/tenant's names plus mail-spool and nothing else", () => {
    const tenant = tenantReserved(tenantSource);
    expect(tenant.length).toBeGreaterThan(0);
    expect(new Set(RESERVED_STACK_NAMES)).toEqual(new Set([...tenant, MAIL_SPOOL_STACK]));
  });

  it('notices a name added to infra/tenant alone (control case)', () => {
    const drifted = tenantSource.replace("'nextcloud1',", "'nextcloud1',\n  'extra-stack',");
    expect(tenantReserved(drifted)).toContain('extra-stack');
    expect(new Set(RESERVED_STACK_NAMES)).not.toEqual(
      new Set([...tenantReserved(drifted), MAIL_SPOOL_STACK])
    );
  });
});
