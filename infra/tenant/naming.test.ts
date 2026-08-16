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

  it('still fails closed against every real object if the bucket name is malformed', () => {
    // `bucketNameFromUrl`'s known gap (see its own describe block) means a
    // malformed `mediaBucketUrl` could reach this function as an empty or
    // slash-containing "bucket name". The isolation boundary must not
    // degrade into an accidental match in that case -- it must degrade into
    // matching nothing, the same fail-closed shape as every other case here.
    const noRealObjectMatches = (malformedBucketName: string) => {
      const condition = mediaObjectConditionResource(malformedBucketName, 'blog');
      expect(objectNameFor('blog', 'content/images/x.jpg').startsWith(condition)).toBe(false);
      expect(objectNameFor('blog-archive', 'x.jpg').startsWith(condition)).toBe(false);
    };
    noRealObjectMatches('');
    noRealObjectMatches(`${BUCKET}/`);
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

  it('rejects the empty string', () => {
    expect(() => bucketNameFromUrl('')).toThrow();
  });

  it('rejects a scheme match that requires the colon-slash-slash exactly', () => {
    // A single slash or a missing colon must not be tolerated as "close
    // enough" -- either would mean this function agrees with a caller who
    // got the scheme wrong instead of failing loudly.
    expect(() => bucketNameFromUrl('gs:/some-bucket')).toThrow();
    expect(() => bucketNameFromUrl('gs//some-bucket')).toThrow();
  });

  it('is case-sensitive on the scheme', () => {
    // `gcp.storage.Bucket.url` always emits lowercase; a caller passing an
    // uppercase scheme is not this documented format and must not silently
    // match it.
    expect(() => bucketNameFromUrl('GS://some-bucket')).toThrow();
  });

  describe('known gap: no validation of the value after the scheme', () => {
    // This function only checks the prefix; it never checks that what
    // remains is a *bucket name* -- no non-empty check, no rejection of an
    // embedded `/`. `gcp.storage.Bucket.url` (this function's only real
    // caller) never produces any of these, so the gap is currently inert,
    // the same class of latent, disclosed defect as `validateTenantName`'s
    // trailing-hyphen case above. It is pinned here, not fixed, because a
    // caller depending on this format changing is a decision this test file
    // does not get to make silently.
    it('accepts an empty bucket name instead of rejecting a scheme with nothing after it', () => {
      expect(bucketNameFromUrl('gs://')).toBe('');
    });

    it('passes a trailing slash through unstripped', () => {
      expect(bucketNameFromUrl('gs://some-bucket/')).toBe('some-bucket/');
    });

    it('passes an embedded path through as if it were part of the bucket name', () => {
      expect(bucketNameFromUrl('gs://some-bucket/some/path')).toBe('some-bucket/some/path');
    });
  });
});

describe('validateTenantName', () => {
  it.each(['blog', 'blog-archive', 'a1', 'x-9-y', 'a', 'a-b-c-d', 'a--b'])('accepts %s', (name) => {
    expect(() => validateTenantName(name)).not.toThrow();
  });

  it.each([
    ['Blog', 'uppercase'],
    ['BLOG', 'all uppercase'],
    ['1blog', 'leading digit'],
    ['-blog', 'leading hyphen'],
    ['blog_archive', 'underscore'],
    ['blog.archive', 'dot'],
    ['', 'empty'],
  ])('rejects %s (%s)', (name) => {
    expect(() => validateTenantName(name)).toThrow();
  });

  describe('whitespace', () => {
    it.each([
      [' ', 'whitespace-only'],
      ['   ', 'multiple spaces'],
      [' blog', 'leading space'],
      ['blog ', 'trailing space'],
      ['blog archive', 'embedded space'],
      ['blog\tarchive', 'embedded tab'],
      ['blog\narchive', 'embedded newline'],
    ])('rejects %j (%s), not merely the trimmed form of it', (name) => {
      // A naive `.trim()` before validating would let any of these through;
      // asserting rejection here pins that no trimming happens.
      expect(() => validateTenantName(name)).toThrow();
    });
  });

  describe('unicode', () => {
    it.each([
      ['blög', 'latin-1 diacritic'],
      // Cyrillic а (U+0430), not the Latin a it is visually indistinguishable from.
      ['blаg', 'cyrillic homoglyph for a latin letter'],
      ['b\u{1F680}log', 'emoji'],
      ['blog​', 'zero-width space'],
    ])('rejects %j (%s)', (name) => {
      expect(() => validateTenantName(name)).toThrow();
    });
  });

  describe('traversal and injection shapes', () => {
    it.each([
      ['../blog', 'leading parent-directory traversal'],
      ['blog/../other', 'embedded parent-directory traversal'],
      ['blog/other', 'path separator'],
      ['/blog', 'leading path separator'],
      ['blog;rm', 'shell metacharacter'],
      ['blog' + String.fromCharCode(0), 'embedded NUL'],
    ])('rejects %j (%s)', (name) => {
      expect(() => validateTenantName(name)).toThrow();
    });
  });

  describe('cross-tenant collision resistance', () => {
    it('rejects the underscore that would let a hyphenated and an underscored name collide once sqlIdentifier folds hyphens', () => {
      expect(() => validateTenantName('a_b')).toThrow();
      expect(sqlIdentifier('a-b')).toBe('a_b');
    });

    it('rejects the case variants that would collide once a caller lowercases for comparison', () => {
      expect(() => validateTenantName('Blog')).toThrow();
      expect(() => validateTenantName('BLOG')).toThrow();
    });
  });

  it('accepts one character under the service-account-ID limit', () => {
    expect(() => validateTenantName('a'.repeat(MAX_TENANT_NAME_LENGTH - 1))).not.toThrow();
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

  describe('known gap: trailing hyphen', () => {
    it('currently accepts a name ending in a hyphen, producing a service account id GCP rejects at apply time', () => {
      // Documents actual behavior, not correctness. GCP's own service-account-ID
      // grammar is `[a-z]([-a-z0-9]*[a-z0-9])` -- it must end in a letter or
      // digit, never a hyphen. This module's pattern ends its character class
      // with `[a-z0-9-]*` and never re-anchors the last character, so nothing
      // here excludes a trailing hyphen. The same string is also the Cloud Run
      // service name (`resource names`, above), which carries the identical
      // RFC-1035 no-trailing-hyphen rule, so both derived identifiers inherit
      // the gap from the one shared validator.
      expect(() => validateTenantName('blog-')).not.toThrow();
      expect(serviceAccountId('blog-')).toBe('ghost-tenant-blog-');
    });
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
