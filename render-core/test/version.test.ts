import { describe, expect, it } from 'vitest';
import type { DigestPinnedRef } from '../src/brand.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import { intendedGhostVersion } from '../src/version.js';
import { demoDescriptor } from './fixtures.js';

const DIGEST = 'b'.repeat(64);

function withImage(image: string): TenantDescriptor {
  return { ...demoDescriptor(), image: image as DigestPinnedRef };
}

describe('intendedGhostVersion()', () => {
  it('reads the semver out of a tagged, digest-pinned image — the shape the estate actually pins', () => {
    expect(intendedGhostVersion(withImage(`ghost:6.55.0-alpine@sha256:${DIGEST}`))).toBe('6.55.0');
  });

  it('reads a bare semver tag with no base-image suffix', () => {
    expect(intendedGhostVersion(withImage(`ghost:6.55.0@sha256:${DIGEST}`))).toBe('6.55.0');
  });

  it('is null for an untagged reference — a valid descriptor by validateDigestPinnedRef, just one this function cannot read', () => {
    expect(intendedGhostVersion(withImage(`ghost@sha256:${DIGEST}`))).toBeNull();
  });

  it('is null when the tag carries no recognisable semver prefix', () => {
    expect(intendedGhostVersion(withImage(`ghost:latest@sha256:${DIGEST}`))).toBeNull();
  });

  it('handles a path-shaped registry name ahead of the tag', () => {
    expect(
      intendedGhostVersion(withImage(`ghcr.io/branchleft/ghost:6.55.0-alpine@sha256:${DIGEST}`))
    ).toBe('6.55.0');
  });

  it('never treats "null, unknown" as a mismatch signal itself — it is a plain string or null, nothing else', () => {
    const result = intendedGhostVersion(withImage(`ghost@sha256:${DIGEST}`));
    expect(result).toBeNull();
    expect(result === false).toBe(false);
  });
});
