import { describe, expect, it } from 'vitest';
import type { Slug } from '../src/brand.js';
import { FieldValidationError } from '../src/brand.js';
import { mediaBucketName, mediaPublicBaseUrl, validateMediaBucket } from '../src/media.js';

const slug = 'acme' as Slug;

describe('mediaBucketName()', () => {
  it('is the platform prefix plus the slug, nothing configurable', () => {
    expect(mediaBucketName(slug)).toBe('branchleft-media-acme');
  });
});

describe('validateMediaBucket()', () => {
  it('passes local media through untouched — no bucket to check', () => {
    expect(() =>
      validateMediaBucket(slug, {
        kind: 'local',
        path: '/data/acme',
        resize: false,
        srcsets: false,
      })
    ).not.toThrow();
  });

  it('accepts an s3 bucket that matches the slug-derived name', () => {
    expect(() =>
      validateMediaBucket(slug, {
        kind: 's3',
        endpoint: 'https://s3.example',
        region: 'eu',
        bucket: 'branchleft-media-acme',
        resize: true,
        srcsets: true,
      })
    ).not.toThrow();
  });

  it('SABOTAGE — a bucket naming another tenant must never validate: red then green', () => {
    const foreign = {
      kind: 's3' as const,
      endpoint: 'https://s3.example',
      region: 'eu',
      bucket: 'branchleft-media-someone-else',
      resize: true,
      srcsets: true,
    };
    // RED: a descriptor naming another tenant's bucket must be refused,
    // not silently trusted.
    expect(() => validateMediaBucket(slug, foreign)).toThrow(FieldValidationError);
    expect(() => validateMediaBucket(slug, foreign)).toThrow(/must be "branchleft-media-acme"/);
    // GREEN: the slug's own bucket still validates.
    expect(() =>
      validateMediaBucket(slug, { ...foreign, bucket: 'branchleft-media-acme' })
    ).not.toThrow();
  });
});

describe('mediaPublicBaseUrl()', () => {
  it('joins the bare endpoint and the derived bucket', () => {
    expect(mediaPublicBaseUrl('https://s3.example', slug)).toBe(
      'https://s3.example/branchleft-media-acme'
    );
  });

  it('trims a trailing slash from the endpoint', () => {
    expect(mediaPublicBaseUrl('https://s3.example/', slug)).toBe(
      'https://s3.example/branchleft-media-acme'
    );
  });

  it('rejects a non-https endpoint', () => {
    expect(() => mediaPublicBaseUrl('http://s3.example', slug)).toThrow(/must be https/);
  });

  it('rejects an endpoint carrying a path', () => {
    expect(() => mediaPublicBaseUrl('https://s3.example/prefix', slug)).toThrow(/bare host/);
  });
});
