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

/** One file of a demo's served media tree. */
export interface ManifestMediaFile {
  /** Its name in the bundle, `content/images/2026/a.png`. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** `oversized`: above the destination's upload ceiling, listed and not carried. */
  readonly status: 'carried' | 'oversized';
}

/**
 * The media files of a demo slot's content volume. `treeFileCount` is every
 * regular file in the served tree (the originals, never `images/size/`), and
 * equals `files.length + unrepresentable.length`.
 */
export interface MediaFilesListing {
  readonly uploadCeilingBytes: number;
  readonly treeFileCount: number;
  readonly files: readonly ManifestMediaFile[];
  /** Files whose name is outside the safe set: not carried, named here. */
  readonly unrepresentable: readonly string[];
  /** References in the content to a file the tree does not hold (held, refused or deleted). */
  readonly danglingReferences: readonly string[];
}

/**
 * What the manifest beside the archive says about the media: counts only. File
 * names are a tenant's own content and that manifest is readable without the
 * key; the full list is in the manifest inside the encrypted archive.
 */
export interface MediaFilesSummary {
  readonly treeFileCount: number;
  readonly carried: number;
  readonly carriedBytes: number;
  readonly oversized: number;
  readonly unrepresentable: number;
  readonly danglingReferences: number;
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
  /** Present only for a demo slot, whose media is local files. */
  readonly mediaFiles?: MediaFilesListing;
}

/** The manifest written beside the archive: the same, with the media list reduced to counts. */
export type SidecarManifest = Omit<ExportManifest, 'mediaFiles'> & {
  readonly mediaFiles?: MediaFilesSummary;
};

export function sidecarOf(manifest: ExportManifest): SidecarManifest {
  const { mediaFiles, ...rest } = manifest;
  if (mediaFiles === undefined) return rest;
  const carried = mediaFiles.files.filter((f) => f.status === 'carried');
  return {
    ...rest,
    mediaFiles: {
      treeFileCount: mediaFiles.treeFileCount,
      carried: carried.length,
      carriedBytes: carried.reduce((n, f) => n + f.size, 0),
      oversized: mediaFiles.files.length - carried.length,
      unrepresentable: mediaFiles.unrepresentable.length,
      danglingReferences: mediaFiles.danglingReferences.length,
    },
  };
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
    name: 'deleted_comments',
    reason:
      "Ghost's admin comment list leaves out comments with status deleted, and blanks their text, so they are not in the archive and the comment count does not include them",
  },
  {
    name: 'media_bytes',
    reason:
      "the archive lists the public address of each media file, never the bytes; those addresses stop working on the tenant's erasure date, and a tenant keeps nothing from them after that unless they download first",
  },
];

function shortfalls(extensions: readonly ExtensionReport[]): ManifestGap[] {
  const gaps: ManifestGap[] = [];
  // The media files of a demo slot are required exactly when they were attempted.
  const required: readonly ExtensionName[] = extensions.some((e) => e.name === 'media_files')
    ? [...REQUIRED_EXTENSIONS, 'media_files']
    : REQUIRED_EXTENSIONS;
  for (const name of required) {
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
  permanentGaps: readonly ManifestGap[] = KNOWN_EXPORT_GAPS,
  mediaFiles?: MediaFilesListing
): ExportManifest {
  const failed = shortfalls(extensions);
  // The bytes are in this archive when the slot's media files were carried.
  const gaps =
    mediaFiles === undefined
      ? permanentGaps
      : permanentGaps.filter((g) => g.name !== 'media_bytes');
  return {
    ...(mediaFiles === undefined ? {} : { mediaFiles }),
    tenantId,
    generatedAt: generatedAtIso,
    encryption,
    complete: failed.length === 0,
    extensions,
    included,
    excluded: [...failed, ...gaps],
  };
}
