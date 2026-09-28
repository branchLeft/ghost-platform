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
  readonly included: readonly ManifestEntry[];
  readonly excluded: readonly ManifestGap[];
}

/**
 * LLD-8 §08b: "an export whose gaps are undocumented is worse than one
 * whose gaps are stated" -- so the four things a separate, later piece of
 * work closes ("export completeness") are named here as gaps rather than
 * left silently absent from the archive. This component's own two
 * `included` entries are Ghost's two existing exports, called as-is;
 * nothing here should be read as this component's opinion
 * on what a *complete* export contains.
 */
export const KNOWN_EXPORT_GAPS: readonly ManifestGap[] = [
  {
    name: 'media',
    reason:
      'the content export references image and file URLs but does not contain the files (D55: a bucket-to-bucket copy or signed-link manifest, not archive bytes)',
  },
  {
    name: 'members_and_subscriptions',
    reason:
      "Ghost exports member state; the commercial relationship (Stripe's side) cannot be handed over by this archive",
  },
  {
    name: 'comments',
    reason:
      'member-written personal data with moderation state, not covered by either Ghost export',
  },
  {
    name: 'analytics_beyond_post_csv',
    reason:
      'the open item named in LLD-8 §11, not closeable before the analytics backend is chosen',
  },
];

export function buildManifest(
  tenantId: string,
  generatedAtIso: string,
  encryption: ManifestEncryption,
  included: readonly ManifestEntry[],
  excluded: readonly ManifestGap[] = KNOWN_EXPORT_GAPS
): ExportManifest {
  return { tenantId, generatedAt: generatedAtIso, encryption, included, excluded };
}
