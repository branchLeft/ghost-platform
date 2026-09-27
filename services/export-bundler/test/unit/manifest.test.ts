import { describe, expect, it } from 'vitest';
import { buildManifest, KNOWN_EXPORT_GAPS } from '../../src/manifest.js';

describe('buildManifest', () => {
  it('names what is included', () => {
    const manifest = buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', [
      { name: 'content_and_settings', path: 'ghost.json' },
      { name: 'post_analytics', path: 'ghost.analytics.csv' },
    ]);
    expect(manifest.included).toEqual([
      { name: 'content_and_settings', path: 'ghost.json' },
      { name: 'post_analytics', path: 'ghost.analytics.csv' },
    ]);
  });

  it("names the known gaps by default -- 'an export whose gaps are undocumented is worse than one whose gaps are stated'", () => {
    const manifest = buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', []);
    expect(manifest.excluded).toBe(KNOWN_EXPORT_GAPS);
    expect(manifest.excluded.map((g) => g.name)).toEqual([
      'media',
      'members_and_subscriptions',
      'comments',
      'analytics_beyond_post_csv',
    ]);
    for (const gap of manifest.excluded) {
      expect(gap.reason.length).toBeGreaterThan(0);
    }
  });

  it('carries the tenant id and timestamp given, not a computed one -- so a caller with a fixed clock gets a deterministic manifest', () => {
    const manifest = buildManifest('tenant-42', '2026-06-01T12:00:00.000Z', []);
    expect(manifest.tenantId).toBe('tenant-42');
    expect(manifest.generatedAt).toBe('2026-06-01T12:00:00.000Z');
  });
});
