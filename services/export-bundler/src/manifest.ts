import type { ExtensionName, ExtensionReport } from './extensions.js';

export interface ManifestEntry {
  readonly name: string;
  readonly path: string;
}

export interface ManifestGap {
  readonly name: string;
  readonly reason: string;
}

/**
 * How the archive is encrypted. The recipient is a public key, so naming it
 * discloses nothing; the fingerprint is what the audit record carries.
 */
export interface ManifestEncryption {
  readonly encrypted: true;
  readonly format: 'age';
  readonly recipient: string;
  readonly recipientFingerprint: string;
}

export interface ExportManifest {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly encryption: ManifestEncryption;
  /**
   * True only when every extension in `REQUIRED_EXTENSIONS` was read and
   * matched its authoritative count. Anything else, including an extension
   * that was never attempted, makes it false.
   */
  readonly complete: boolean;
  readonly extensions: readonly ExtensionReport[];
  readonly included: readonly ManifestEntry[];
  readonly excluded: readonly ManifestGap[];
}

export const REQUIRED_EXTENSIONS: readonly ExtensionName[] = [
  'media',
  'members_and_subscriptions',
  'comments',
];

/**
 * What no archive from this bundler can contain, named so the tenant finds
 * out before they leave rather than after. These are limits of reach, not
 * failures: they do not make a run incomplete.
 */
export const KNOWN_EXPORT_GAPS: readonly ManifestGap[] = [
  {
    name: 'analytics_beyond_post_csv',
    reason:
      'the open item named in LLD-8 §11, not closeable before the analytics backend is chosen',
  },
  {
    name: 'stripe_billing_relationship',
    reason:
      "Stripe's side of each subscription cannot be moved by this archive: the archive carries Ghost's subscription records, and the ability to keep charging those cards elsewhere is Stripe's to move",
  },
  {
    name: 'portal_moderation_record',
    reason:
      "classifier verdicts and moderator decisions held by the portal's moderation queue are not in Ghost and not in this archive; the archive carries Ghost's own status and the member reports for each comment",
  },
  {
    name: 'media_bytes',
    reason:
      'the archive carries a manifest of time-bounded links to the media, never the bytes; the links expire, and a tenant keeps nothing from them after that unless they download first',
  },
];

function shortfalls(extensions: readonly ExtensionReport[]): ManifestGap[] {
  const gaps: ManifestGap[] = [];
  for (const name of REQUIRED_EXTENSIONS) {
    const report = extensions.find((e) => e.name === name);
    if (report === undefined) {
      gaps.push({ name, reason: 'not attempted' });
    } else if (report.status === 'complete' && report.expected !== report.present) {
      // A report that says complete over a short count is a defect in the
      // collector, and the manifest must not repeat it.
      gaps.push({
        name,
        reason: `reported complete but present ${report.present} of expected ${String(report.expected)}`,
      });
    } else if (report.status !== 'complete') {
      gaps.push({
        name,
        reason: `${report.status}: ${report.notes.join('; ')}`,
      });
    }
  }
  return gaps;
}

export function buildManifest(
  tenantId: string,
  generatedAtIso: string,
  encryption: ManifestEncryption,
  included: readonly ManifestEntry[],
  extensions: readonly ExtensionReport[] = [],
  permanentGaps: readonly ManifestGap[] = KNOWN_EXPORT_GAPS
): ExportManifest {
  const failed = shortfalls(extensions);
  return {
    tenantId,
    generatedAt: generatedAtIso,
    encryption,
    complete: failed.length === 0,
    extensions,
    included,
    excluded: [...failed, ...permanentGaps],
  };
}
