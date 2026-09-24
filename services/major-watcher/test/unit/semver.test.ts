import { describe, expect, it } from 'vitest';
import { parseGhostTag } from '../../src/semver.js';

describe('parseGhostTag', () => {
  it('parses a full release tag', () => {
    expect(parseGhostTag('v6.55.0')).toEqual({ major: 6, minor: 55, patch: 0, prerelease: null });
  });

  it('parses a prerelease tag', () => {
    expect(parseGhostTag('v6.0.0-alpha.1')).toEqual({
      major: 6,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
    });
  });

  it('parses an rc tag, independent of any API-reported prerelease flag', () => {
    // This is the real trap: github.com/TryGhost/Ghost's v6.0.0-rc.2 is
    // flagged `prerelease: false` by GitHub's own API (checked live,
    // 2026-09-24), despite its tag being unambiguously a release candidate.
    // The tag string must still be read as a prerelease.
    expect(parseGhostTag('v6.0.0-rc.2')?.prerelease).toBe('rc.2');
  });

  it('tolerates a missing v prefix', () => {
    expect(parseGhostTag('7.0.0')).toEqual({ major: 7, minor: 0, patch: 0, prerelease: null });
  });

  it('returns null for a non-semver tag', () => {
    expect(parseGhostTag('latest')).toBeNull();
    expect(parseGhostTag('')).toBeNull();
    expect(parseGhostTag('v6.55')).toBeNull();
  });
});
