import { describe, expect, it } from 'vitest';
import { targetFromEnv, TargetError } from './journey/target.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('what the journey is pointed at', () => {
  it('runs the built checkout when no image is named', () => {
    expect(targetFromEnv({})).toEqual({ kind: 'dist' });
    expect(targetFromEnv({ JOURNEY_IMAGE: '   ' })).toEqual({ kind: 'dist' });
  });

  it('runs an image named by digest', () => {
    const reference = `ghcr.io/branchleft/portal-apps@${DIGEST}`;
    expect(targetFromEnv({ JOURNEY_IMAGE: reference })).toEqual({ kind: 'image', reference });
  });

  it.each([
    ['a tag', 'ghcr.io/branchleft/portal-apps:latest'],
    ['a tag with a digest-looking suffix', `ghcr.io/branchleft/portal-apps:${DIGEST}`],
    ['no registry', `portal-apps@${DIGEST}`],
    ['a short digest', 'ghcr.io/branchleft/portal-apps@sha256:abc123'],
    ['an upper-case digest', `ghcr.io/branchleft/portal-apps@sha256:${'A'.repeat(64)}`],
    ['a shell word after it', `ghcr.io/branchleft/portal-apps@${DIGEST} --privileged`],
  ])('refuses %s, so nothing starts from an image that was not pinned', (_name, reference) => {
    expect(() => targetFromEnv({ JOURNEY_IMAGE: reference })).toThrow(TargetError);
  });
});
