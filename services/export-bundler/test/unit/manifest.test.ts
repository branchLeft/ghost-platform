import { describe, expect, it } from 'vitest';
import { buildManifest, KNOWN_EXPORT_GAPS, type ManifestEncryption } from '../../src/manifest.js';

const encryption: ManifestEncryption = {
  encrypted: true,
  format: 'age',
  recipient: 'age1example',
  recipientFingerprint: 'sha256:abc',
};

describe('buildManifest', () => {
  it('names what is included', () => {
    const manifest = buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', encryption, [
      { name: 'content_and_settings', path: 'content_and_settings.json' },
      { name: 'post_analytics', path: 'post_analytics.csv' },
    ]);
    expect(manifest.included).toEqual([
      { name: 'content_and_settings', path: 'content_and_settings.json' },
      { name: 'post_analytics', path: 'post_analytics.csv' },
    ]);
  });

  it('states that the archive is encrypted, with age, and to which recipient fingerprint', () => {
    const manifest = buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', encryption, []);
    expect(manifest.encryption).toEqual(encryption);
  });

  it("names the known gaps by default -- 'an export whose gaps are undocumented is worse than one whose gaps are stated'", () => {
    const manifest = buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', encryption, []);
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
    const manifest = buildManifest('tenant-42', '2026-06-01T12:00:00.000Z', encryption, []);
    expect(manifest.tenantId).toBe('tenant-42');
    expect(manifest.generatedAt).toBe('2026-06-01T12:00:00.000Z');
  });
});
