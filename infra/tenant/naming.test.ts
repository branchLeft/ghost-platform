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
  it.each(['blog', 'a', 'example-news', 'news2', 'a1-b2-c3', 'blog-x'])('accepts %s', (slug) => {
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
    // A slug ending in a hyphen turns into an S3-incompatible media-bucket
    // name two functions later (`mediaBucketName`); the boundary belongs
    // here, before `GhostTenant`'s constructor calls `super()`, not there.
    ['blog-', 'must not end with a hyphen'],
    ['-', 'a bare hyphen is both a leading and a trailing hyphen'],
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

  it('rejects a trailing hyphen even when the slug is otherwise at the length limit', () => {
    // Exactly `MAX_TENANT_SLUG_LENGTH` characters, so only the trailing
    // hyphen -- not the length check -- can be what rejects this.
    const atLimitWithTrailingHyphen = `${'a'.repeat(MAX_TENANT_SLUG_LENGTH - 1)}-`;
    expect(atLimitWithTrailingHyphen.length).toBe(MAX_TENANT_SLUG_LENGTH);
    expect(() => validateTenantSlug(atLimitWithTrailingHyphen)).toThrow(/lowercase letter/);
  });

  // A tenant slugged `website` would land on top of the marketing site's
  // Compose project, secrets file and systemd unit on the same host, and
  // nothing downstream would object.
  it.each(RESERVED_STACK_NAMES)('refuses the reserved stack name %s', (slug) => {
    expect(() => validateTenantSlug(slug)).toThrow(/reserved/);
  });

  // The guard must not simply refuse everything: a slug nothing on a host
  // already holds has to pass. `demo-1` is the exact control case the
  // originating report ran this guard against.
  it('still accepts a slug nothing on a host holds', () => {
    expect(() => validateTenantSlug('demo-1')).not.toThrow();
  });
});

describe('RESERVED_STACK_NAMES against the shared-infra stack register', () => {
  // A snapshot of branchLeft/shared-infra's `hetzner/provision/` stack
  // register, taken 2026-09-27: `CONTRACT_COVERS` (`EXPECTED_SERVICES`'s
  // keys: stacks whose Compose file that repository commits) union
  // `CONTRACT_DOES_NOT_REACH` (stacks a Compose file elsewhere starts, each
  // naming its owning repository) in
  // `hetzner/provision/test_compose_unit_contract.py`, confirmed against
  // `hetzner/provision/sites.ts`.
  //
  // `blog` is EXCLUDED here even though shared-infra's register names it —
  // see the long comment on `RESERVED_STACK_NAMES` above for why it cannot
  // be added to that constant. This snapshot is therefore "the register
  // minus that one documented exception", not the register verbatim.
  //
  // To refresh: re-read `CONTRACT_COVERS`/`CONTRACT_DOES_NOT_REACH` from
  // shared-infra's `main` (`git -C <shared-infra clone> show
  // origin/main:hetzner/provision/test_compose_unit_contract.py`), diff
  // against the array below, and update both this snapshot and
  // `RESERVED_STACK_NAMES` together — a diff between them, not a silent
  // edit to one side, is what should ever change this test's outcome.
  const SHARED_INFRA_REGISTER_SNAPSHOT_MINUS_BLOG = [
    'edge',
    'monitoring',
    'nextcloud1',
    'website',
    'db',
  ];

  it('has not drifted from the committed shared-infra register snapshot', () => {
    expect(new Set(RESERVED_STACK_NAMES)).toEqual(
      new Set(SHARED_INFRA_REGISTER_SNAPSHOT_MINUS_BLOG)
    );
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
