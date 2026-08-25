import { describe, expect, it } from 'vitest';
import { MEDIA_BUCKET_PREFIX, mediaBucketName, mediaPublicBaseUrl } from './media';

const ENDPOINT = 'https://hel1.your-objectstorage.com';

describe('mediaBucketName', () => {
  it('names a bucket per tenant, prefixed away from the estate buckets', () => {
    expect(mediaBucketName('blog')).toBe('branchleft-media-blog');
    expect(MEDIA_BUCKET_PREFIX).toBe('branchleft-media-');
  });

  // The value this same derivation must produce in
  // infra/provisioning/scripts/render-media-bucket-policy.py, which runs
  // before this component sees the tenant. Asserted as a literal on both
  // sides so a change to one fails the other's tests.
  it('agrees with render-media-bucket-policy.py on the bucket name', () => {
    expect(mediaBucketName('blog')).toBe('branchleft-media-blog');
    expect(mediaBucketName('example-news')).toBe('branchleft-media-example-news');
  });

  // The failure the shared-bucket shape had to defend against with a
  // trailing-slash subtlety on the key prefix. Bucket-per-tenant removes it
  // structurally -- these are two buckets, not two prefixes -- but the test
  // stays, because it is the property the isolation rests on.
  it('gives distinct buckets to slugs where one is a prefix of the other', () => {
    expect(mediaBucketName('blog')).not.toBe(mediaBucketName('blog-archive'));
    // And the shorter name is not a *path* prefix of the longer one: an
    // `arn:...:branchleft-media-blog/*` resource cannot match an object in
    // `branchleft-media-blog-archive`, because the separator is a `/`.
    expect(mediaBucketName('blog-archive').startsWith(`${mediaBucketName('blog')}/`)).toBe(false);
  });

  it('refuses a slug whose bucket name S3 would reject', () => {
    expect(() => mediaBucketName('blog-')).toThrow(/letter or a digit/);
  });

  it('applies the component slug rules before deriving anything', () => {
    expect(() => mediaBucketName('Blog')).toThrow(/lowercase letter/);
    expect(() => mediaBucketName('website')).toThrow(/reserved/);
    expect(() => mediaBucketName('blog/../website')).toThrow(/lowercase letter/);
  });

  it('stays inside S3 63-character bucket-name limit at the longest legal slug', () => {
    const longest = 'a'.repeat(26);
    expect(mediaBucketName(longest).length).toBeLessThanOrEqual(63);
    expect(mediaBucketName(longest).length).toBeGreaterThanOrEqual(3);
  });
});

describe('mediaPublicBaseUrl', () => {
  it('serves path-style from the storage host', () => {
    expect(mediaPublicBaseUrl(ENDPOINT, 'blog')).toBe(
      'https://hel1.your-objectstorage.com/branchleft-media-blog'
    );
  });

  it('tolerates a trailing slash on the endpoint rather than emitting a double one', () => {
    expect(mediaPublicBaseUrl(`${ENDPOINT}/`, 'blog')).toBe(mediaPublicBaseUrl(ENDPOINT, 'blog'));
    expect(mediaPublicBaseUrl(`${ENDPOINT}${'/'.repeat(64)}`, 'blog')).toBe(
      mediaPublicBaseUrl(ENDPOINT, 'blog')
    );
  });

  // Ghost writes this into every published post. A wrong value here is not a
  // config error to fix later; it is a set of URLs already in readers' feeds.
  it('refuses a non-https endpoint', () => {
    expect(() => mediaPublicBaseUrl('http://hel1.your-objectstorage.com', 'blog')).toThrow(
      /must be https/
    );
  });

  it('refuses an endpoint carrying a path', () => {
    expect(() =>
      mediaPublicBaseUrl('https://hel1.your-objectstorage.com/branchleft-media', 'blog')
    ).toThrow(/bare host/);
  });

  it('gives distinct base URLs to slugs where one is a prefix of the other', () => {
    expect(mediaPublicBaseUrl(ENDPOINT, 'blog')).not.toBe(
      mediaPublicBaseUrl(ENDPOINT, 'blog-archive')
    );
  });
});
