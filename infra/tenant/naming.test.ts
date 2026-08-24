import { describe, expect, it } from 'vitest';
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
  validateTenantSlug,
} from './naming';

describe('validateTenantSlug', () => {
  it.each(['blog', 'a', 'example-news', 'news2', 'a1-b2-c3'])('accepts %s', (slug) => {
    expect(() => validateTenantSlug(slug)).not.toThrow();
  });

  it.each([
    ['1blog', 'must not start with a digit'],
    ['-blog', 'must not start with a hyphen'],
    ['Blog', 'must not carry uppercase'],
    ['blog_one', 'must not carry an underscore'],
    ['blog.one', 'must not carry a dot'],
    ['blog one', 'must not carry a space'],
    ['', 'must not be empty'],
    ['blog/../website', 'must not carry a path traversal'],
  ])('rejects %s (%s)', (slug) => {
    expect(() => validateTenantSlug(slug)).toThrow(/lowercase letter/);
  });

  it('rejects a slug too long for MySQL account names', () => {
    expect(MAX_TENANT_SLUG_LENGTH).toBe(26);
    expect(() => validateTenantSlug('a'.repeat(MAX_TENANT_SLUG_LENGTH))).not.toThrow();
    expect(() => validateTenantSlug('a'.repeat(MAX_TENANT_SLUG_LENGTH + 1))).toThrow(
      /32-character account-name limit/
    );
  });

  // A tenant slugged `website` would land on top of the marketing site's
  // Compose project, secrets file and systemd unit on the same host, and
  // nothing downstream would object.
  it.each(RESERVED_STACK_NAMES)('refuses the reserved stack name %s', (slug) => {
    expect(() => validateTenantSlug(slug)).toThrow(/reserved/);
  });
});

describe('derived names', () => {
  it('folds hyphens for MySQL identifiers only', () => {
    expect(sqlIdentifier('example-news')).toBe('example_news');
    expect(databaseAndUserName('example-news')).toBe('ghost_example_news');
    // Everything that is not a MySQL identifier keeps the hyphen.
    expect(stackName('example-news')).toBe('example-news');
    expect(contentVolumeName('example-news')).toBe('ghost-example-news-content');
  });

  it('agrees with db/provision/naming.py on the database and user name', () => {
    // `TENANT_DB_PREFIX + sql_identifier(slug)` there; the same string here.
    expect(databaseAndUserName('blog')).toBe('ghost_blog');
  });

  it('keeps one name across the Compose project, unit, directory and files', () => {
    expect(stackName('blog')).toBe('blog');
    expect(stackDirectory('blog')).toBe('/opt/branchleft/blog');
    expect(composeUnitName('blog')).toBe('branchleft-compose@blog.service');
    expect(secretsEnvPath('blog')).toBe('/etc/branchleft/blog.env');
    expect(imageEnvPath('blog')).toBe('/etc/branchleft/blog.image.env');
  });

  it('never gives the secrets file and the image file the same path', () => {
    // branchleft-deploy writes one of these and must never write the other.
    expect(secretsEnvPath('blog')).not.toBe(imageEnvPath('blog'));
  });

  it('gives the two volumes distinct, slug-scoped names', () => {
    expect(contentVolumeName('blog')).toBe('ghost-blog-content');
    expect(adaptersVolumeName('blog')).toBe('ghost-blog-adapters');
    expect(contentVolumeName('blog')).not.toBe(adaptersVolumeName('blog'));
  });

  // Prefix collision: without the `-content`/`-adapters` suffixes being
  // appended to the full slug, tenant `blog` and tenant `blog-archive` would
  // be one hyphen apart from sharing a volume.
  it('does not collide across slugs that share a prefix', () => {
    expect(contentVolumeName('blog')).not.toBe(contentVolumeName('blog-archive'));
    expect(databaseAndUserName('blog')).not.toBe(databaseAndUserName('blog-archive'));
  });
});
