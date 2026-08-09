import { describe, it, expect } from 'vitest';
import {
  MAX_TENANT_NAME_LENGTH,
  bucketNameFromUrl,
  cloudRunServiceName,
  databaseAndUserName,
  mediaObjectConditionResource,
  mediaObjectPrefix,
  mediaTenantPrefixEnvValue,
  serviceAccountId,
  sqlIdentifier,
  tenantImageRef,
  tenantSecretName,
  validateTenantName,
} from './naming';

/**
 * The IAM conditions in `storage.ts` are `resource.name.startsWith(<prefix>)`.
 * These cases assert the boundary that expression relies on, against the
 * substring relation itself rather than against a restatement of the format.
 */
describe('media object isolation', () => {
  const BUCKET = 'branchleft-prod-ghost-platform-media';
  const grantedTo = (tenant: string) => mediaObjectConditionResource(BUCKET, tenant);
  const objectNameFor = (tenant: string, key: string) =>
    `projects/_/buckets/${BUCKET}/objects/${tenant}/${key}`;

  it('matches the tenant its own objects', () => {
    expect(objectNameFor('blog', 'content/images/x.jpg').startsWith(grantedTo('blog'))).toBe(true);
  });

  it('does not match a tenant whose name extends this one', () => {
    // The whole reason the prefix carries a trailing slash. Without it,
    // "blog" would be granted every object under "blog-archive/".
    expect(
      objectNameFor('blog-archive', 'content/images/x.jpg').startsWith(grantedTo('blog'))
    ).toBe(false);
  });

  it('is not satisfied by a tenant name appearing later in the key', () => {
    expect(objectNameFor('other', 'blog/x.jpg').startsWith(grantedTo('blog'))).toBe(false);
  });

  it('does not leak across buckets', () => {
    const otherBucket = `projects/_/buckets/some-other-bucket/objects/blog/x.jpg`;
    expect(otherBucket.startsWith(grantedTo('blog'))).toBe(false);
  });

  it('keeps the trailing slash in the prefix itself', () => {
    expect(mediaObjectPrefix('blog')).toBe('blog/');
    expect(grantedTo('blog').endsWith('/')).toBe(true);
  });

  it('gives Ghost the same prefix without the separator it appends itself', () => {
    // The two differ by exactly one slash, and both directions fail quietly:
    // a slash in the env value writes every object under `blog//`, and no
    // slash in the IAM condition opens `blog-archive/` to `blog`.
    for (const tenant of ['blog', 'blog-archive', 'a']) {
      expect(mediaObjectPrefix(tenant)).toBe(`${mediaTenantPrefixEnvValue(tenant)}/`);
      expect(mediaTenantPrefixEnvValue(tenant).endsWith('/')).toBe(false);
    }
  });
});

describe('tenantImageRef', () => {
  const REPO = 'europe-west1-docker.pkg.dev/branchleft-prod/ghost-platform-tenant';
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  it('joins a digest with @', () => {
    expect(tenantImageRef(REPO, DIGEST)).toBe(`${REPO}/ghost@${DIGEST}`);
  });

  it('joins a tag with :', () => {
    expect(tenantImageRef(REPO, '1.2.3')).toBe(`${REPO}/ghost:1.2.3`);
  });

  it('never emits the two-colon form Cloud Run rejects', () => {
    // The original defect: `.../ghost:sha256:<hex>` is a 400 at create time,
    // so a digest-pinned tenant could not be deployed at all.
    expect(tenantImageRef(REPO, DIGEST)).not.toContain('ghost:sha256:');
  });

  it('treats only a leading sha256: as a digest', () => {
    // A tag is free to contain "sha256" anywhere but the start; `@` there
    // would produce a reference to a digest that does not exist.
    expect(tenantImageRef(REPO, 'build-sha256-1')).toBe(`${REPO}/ghost:build-sha256-1`);
  });
});

describe('tenantSecretName', () => {
  it('shares the resource prefix with the service account', () => {
    expect(tenantSecretName('blog', 'db-password')).toBe('ghost-tenant-blog-db-password');
    expect(tenantSecretName('blog', 'db-password').startsWith(serviceAccountId('blog'))).toBe(true);
  });

  it('keeps distinct suffixes distinct', () => {
    expect(tenantSecretName('blog', 'db-username')).not.toBe(
      tenantSecretName('blog', 'db-password')
    );
  });
});

describe('bucketNameFromUrl', () => {
  it('strips the documented scheme', () => {
    expect(bucketNameFromUrl('gs://some-bucket')).toBe('some-bucket');
  });

  it('rejects a URL that is not gs://, rather than silently returning it', () => {
    expect(() => bucketNameFromUrl('https://storage.googleapis.com/some-bucket')).toThrow(
      /doesn't start with "gs:\/\/"/
    );
  });

  it('rejects a bare bucket name', () => {
    expect(() => bucketNameFromUrl('some-bucket')).toThrow();
  });
});

describe('validateTenantName', () => {
  it.each(['blog', 'blog-archive', 'a1', 'x-9-y'])('accepts %s', (name) => {
    expect(() => validateTenantName(name)).not.toThrow();
  });

  it.each([
    ['Blog', 'uppercase'],
    ['1blog', 'leading digit'],
    ['-blog', 'leading hyphen'],
    ['blog_archive', 'underscore'],
    ['blog.archive', 'dot'],
    ['', 'empty'],
  ])('rejects %s (%s)', (name) => {
    expect(() => validateTenantName(name)).toThrow();
  });

  it('accepts a name at the service-account-ID limit', () => {
    expect(() => validateTenantName('a'.repeat(MAX_TENANT_NAME_LENGTH))).not.toThrow();
  });

  it('rejects one character beyond it', () => {
    expect(() => validateTenantName('a'.repeat(MAX_TENANT_NAME_LENGTH + 1))).toThrow(/at most/);
  });

  it('keeps the derived service account id inside GCP 30-character limit', () => {
    const longest = 'a'.repeat(MAX_TENANT_NAME_LENGTH);
    expect(serviceAccountId(longest).length).toBeLessThanOrEqual(30);
  });
});

describe('SQL identifiers', () => {
  it('folds hyphens, which MySQL identifiers cannot carry unquoted', () => {
    expect(sqlIdentifier('blog-archive')).toBe('blog_archive');
  });

  it('leaves a hyphen-free name alone', () => {
    expect(sqlIdentifier('blog')).toBe('blog');
  });

  it('folds every hyphen, not just the first', () => {
    expect(sqlIdentifier('a-b-c')).toBe('a_b_c');
  });

  it('names the database and its user identically', () => {
    expect(databaseAndUserName(sqlIdentifier('blog-archive'))).toBe('ghost_blog_archive');
  });
});

describe('resource names', () => {
  it('derives the service account and the Cloud Run service alike, for now', () => {
    // Two separate string literals before this module existed, and kept as two
    // functions deliberately: these are different resource types with
    // different grammars, and the service-account id is the one bounded to 30
    // characters. They coincide today, and this case exists so that changing
    // that is a deliberate edit here rather than a drift noticed in
    // production, where a tenant's URL comes from the Cloud Run name.
    expect(cloudRunServiceName('blog')).toBe(serviceAccountId('blog'));
  });

  it('prefixes both', () => {
    expect(serviceAccountId('blog')).toBe('ghost-tenant-blog');
  });
});
