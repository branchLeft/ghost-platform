import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  KNOWN_EXPORT_GAPS,
  REQUIRED_EXTENSIONS,
  type ManifestEncryption,
} from '../../src/manifest.js';
import type { ExtensionReport } from '../../src/extensions.js';

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

  it('names the permanent limits by default, and none of them makes a run incomplete', () => {
    const manifest = buildManifest(
      'tenant-1',
      '2026-01-01T00:00:00.000Z',
      encryption,
      [],
      [
        ...REQUIRED_EXTENSIONS.map((name): ExtensionReport => ({
          name,
          status: 'complete',
          expected: 1,
          present: 1,
          notes: [],
          info: [],
        })),
      ]
    );
    expect(manifest.excluded).toEqual(KNOWN_EXPORT_GAPS);
    expect(manifest.excluded.map((g) => g.name)).toEqual([
      'analytics_beyond_post_csv',
      'stripe_billing_relationship',
      'portal_moderation_record',
      'deleted_comments',
      'media_bytes',
    ]);
    expect(manifest.complete).toBe(true);
    for (const gap of manifest.excluded) {
      expect(gap.reason.length).toBeGreaterThan(0);
    }
  });

  it('carries the tenant id and timestamp given, not a computed one -- so a caller with a fixed clock gets a deterministic manifest', () => {
    const manifest = buildManifest('tenant-42', '2026-06-01T12:00:00.000Z', encryption, []);
    expect(manifest.tenantId).toBe('tenant-42');
    expect(manifest.generatedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  describe('completeness', () => {
    const report = (over: Partial<ExtensionReport>): ExtensionReport => ({
      name: 'media',
      status: 'complete',
      expected: 2,
      present: 2,
      notes: [],
      info: [],
      ...over,
    });
    const all = (over: Partial<Record<ExtensionReport['name'], Partial<ExtensionReport>>> = {}) =>
      REQUIRED_EXTENSIONS.map((name) => report({ name, ...over[name] }));
    const build = (extensions: readonly ExtensionReport[]) =>
      buildManifest('tenant-1', '2026-01-01T00:00:00.000Z', encryption, [], extensions);

    it('claims completeness only when all three extensions are complete and counted', () => {
      const manifest = build(all());
      expect(manifest.complete).toBe(true);
      expect(manifest.excluded).toEqual(KNOWN_EXPORT_GAPS);
    });

    it.each(REQUIRED_EXTENSIONS)(
      'does NOT claim completeness when %s failed, and names why',
      (name) => {
        const manifest = build(
          all({
            [name]: {
              status: 'failed',
              expected: null,
              present: 0,
              notes: ['GhostExportError on /x (500)'],
            },
          })
        );
        expect(manifest.complete).toBe(false);
        expect(manifest.excluded[0]).toEqual({
          name,
          reason: 'failed: GhostExportError on /x (500)',
        });
      }
    );

    it('does NOT claim completeness for a partial extension', () => {
      const manifest = build(
        all({
          comments: {
            status: 'partial',
            expected: 9,
            present: 4,
            notes: ['read 4 comments, Ghost counts 9'],
          },
        })
      );
      expect(manifest.complete).toBe(false);
      expect(manifest.excluded[0]?.reason).toBe('partial: read 4 comments, Ghost counts 9');
    });

    it('does NOT claim completeness for an extension that was never attempted', () => {
      const manifest = build(all().slice(0, 2));
      expect(manifest.complete).toBe(false);
      expect(manifest.excluded[0]).toEqual({ name: 'comments', reason: 'not attempted' });
      expect(
        build([])
          .excluded.slice(0, 3)
          .map((g) => g.reason)
      ).toEqual(['not attempted', 'not attempted', 'not attempted']);
    });

    it('does NOT repeat a collector that says complete over a short count', () => {
      const manifest = build(all({ members_and_subscriptions: { expected: 10, present: 7 } }));
      expect(manifest.complete).toBe(false);
      expect(manifest.excluded[0]?.reason).toBe('reported complete but present 7 of expected 10');
      const unknown = build(all({ media: { expected: null, present: 0 } }));
      expect(unknown.complete).toBe(false);
      expect(unknown.excluded[0]?.reason).toBe('reported complete but present 0 of expected null');
    });
  });
});
