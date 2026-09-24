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
      // RED: this is workspace#1144's own finding, carried onto render-core
      // by review — a reserved name must never validate.
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
