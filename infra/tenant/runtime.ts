/**
 * The numbers that bound one tenant container on a shared app host: its UID,
 * its upload ceiling and everything derived from that ceiling, and its
 * resource caps.
 *
 * Every value here is a planning figure to be re-measured, not a promise.
 * What is *not* provisional is the relationship between them — three
 * separately-configured limits have to agree about how large an upload may
 * be, and they are derived from one input here rather than set three times.
 */

/**
 * Per-tenant UIDs come from a reserved range, are distinct per tenant and are
 * never reused. The range sits far above any account a Debian host creates
 * for itself, so a tenant UID can never collide with a real host user and
 * inherit its group memberships.
 */
export const TENANT_UID_MIN = 30000;
export const TENANT_UID_MAX = 30999;

export function validateTenantUid(uid: number): void {
  if (!Number.isInteger(uid)) {
    throw new Error(`GhostTenant: uid ${uid} must be an integer.`);
  }
  if (uid < TENANT_UID_MIN || uid > TENANT_UID_MAX) {
    throw new Error(
      `GhostTenant: uid ${uid} is outside the reserved tenant range ` +
        `${TENANT_UID_MIN}-${TENANT_UID_MAX}. A UID outside it may belong to a real account on ` +
        `the app host, whose group memberships the tenant container would then inherit.`
    );
  }
}

/**
 * Default upload ceiling, in MiB. The single input every upload-related limit
 * below derives from.
 *
 * It cannot be read off Ghost's own defaults: Ghost 6.55.0 accepts a 1 GiB
 * compressed theme expanding to 4 GiB, and its generic upload middleware
 * (`multer({dest: os.tmpdir()})`) carries no limit at all. Both stage bytes
 * in `/tmp`, which on a read-only rootfs is a tmpfs charged to the
 * container's memory cgroup — so Ghost's own limits are not a per-tenant
 * memory budget on a 4-8 GB host, and the platform imposes its own.
 */
export const DEFAULT_UPLOAD_CEILING_MIB = 128;

/**
 * Resident-set budget for Ghost itself, in MiB, before the tmpfs is added.
 * Measured-under-load figures put a near-idle tenant well under this; the
 * headroom is deliberate.
 */
export const DEFAULT_RSS_BUDGET_MIB = 512;

const MIB = 1024 * 1024;

/**
 * The ceiling has to divide evenly by 4 so every derived value below is a
 * whole number of MiB, and be large enough that a stock Casper-sized theme
 * still uploads.
 */
const MIN_UPLOAD_CEILING_MIB = 16;
const UPLOAD_CEILING_DIVISOR = 4;

export interface UploadLimits {
  /** `tmpfs: /tmp` `size=`. The backstop under everything below: a write past
   * it fails one upload with `ENOSPC` rather than taking the host down. */
  tmpfsSize: string;
  /** `theme__uploadLimits__compressedBytes`. */
  themeCompressedBytes: number;
  /** `theme__uploadLimits__entryUncompressedBytes`. */
  themeEntryUncompressedBytes: number;
  /** `theme__uploadLimits__totalUncompressedBytes`. */
  themeTotalUncompressedBytes: number;
  /**
   * The tenant's Caddy `request_body max_size` at the edge, in Caddy's own
   * size syntax. The only limit that bounds the upload paths Ghost leaves
   * unlimited, and the only one that rejects an oversized body before it
   * reaches an app host at all.
   */
  edgeRequestBodyMaxSize: string;
  /** `mem_limit` and `memswap_limit`: the RSS budget plus the tmpfs ceiling,
   * because tmpfs pages are charged to the same cgroup. */
  memoryLimit: string;
}

/**
 * Derives every upload-related limit from one ceiling.
 *
 * The proportions, and why they are not all equal to the ceiling:
 *
 * - Theme *extraction* happens in `/tmp`, and the compressed archive is still
 *   there while it expands — so the uncompressed total gets half the tmpfs and
 *   not all of it.
 * - The edge limit bounds a single request body. At half the ceiling two
 *   concurrent uploads still fit in `/tmp`; at the full ceiling one upload
 *   plus any concurrent theme extraction does not.
 * - Only `theme__uploadLimits__*` can bound extraction, because they are what
 *   Ghost hands to `gscan.checkZip`; a proxy in front cannot see how far a
 *   compressed archive expands. Only the edge limit can bound the image,
 *   media, file and content-import paths, because Ghost sets no limit on
 *   those at all. Neither one substitutes for the other, which is why both
 *   are set.
 */
export function uploadLimits(
  uploadCeilingMib: number,
  rssBudgetMib: number = DEFAULT_RSS_BUDGET_MIB
): UploadLimits {
  if (!Number.isInteger(uploadCeilingMib) || uploadCeilingMib < MIN_UPLOAD_CEILING_MIB) {
    throw new Error(
      `GhostTenant: uploadCeilingMib must be an integer of at least ${MIN_UPLOAD_CEILING_MIB}, ` +
        `got ${uploadCeilingMib}.`
    );
  }
  if (uploadCeilingMib % UPLOAD_CEILING_DIVISOR !== 0) {
    throw new Error(
      `GhostTenant: uploadCeilingMib must be a multiple of ${UPLOAD_CEILING_DIVISOR} so every ` +
        `derived limit is a whole number of MiB, got ${uploadCeilingMib}.`
    );
  }
  if (!Number.isInteger(rssBudgetMib) || rssBudgetMib <= 0) {
    throw new Error(`GhostTenant: rssBudgetMib must be a positive integer, got ${rssBudgetMib}.`);
  }

  return {
    tmpfsSize: `${uploadCeilingMib}m`,
    themeCompressedBytes: (uploadCeilingMib / 4) * MIB,
    themeEntryUncompressedBytes: (uploadCeilingMib / 4) * MIB,
    themeTotalUncompressedBytes: (uploadCeilingMib / 2) * MIB,
    edgeRequestBodyMaxSize: `${uploadCeilingMib / 2}MB`,
    memoryLimit: `${rssBudgetMib + uploadCeilingMib}m`,
  };
}

export interface ResourceCaps {
  /** Hard CPU ceiling. `cpu_shares` is a relative weight with no ceiling, so
   * on a deliberately oversubscribed host it cannot express this. */
  cpus: string;
  /** Relative weight under contention. Set alongside `cpus`, not instead. */
  cpuShares: number;
  /** Bounds a fork bomb and `sharp`'s thread growth. */
  pidsLimit: number;
  /** Bounds descriptor exhaustion. */
  nofile: number;
}

/**
 * Defaults sized generously against a `cx23`-class host: a legitimate burst —
 * image transforms on a bulk upload, a sitemap regeneration — is throttled
 * rather than allowed to borrow the whole host, which is the intent, so the
 * ceiling sits near half the host's vCPU rather than close to one core.
 */
export const DEFAULT_RESOURCE_CAPS: ResourceCaps = {
  cpus: '1.0',
  cpuShares: 512,
  pidsLimit: 256,
  nofile: 4096,
};
