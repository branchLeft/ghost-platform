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
   *
   * `MiB`, not `MB`: Caddy reads `MB` as a power of ten and every other value
   * derived here is a power of two. The point of deriving them from one input
   * is that they cannot disagree, and a unit that means something else by
   * ~4.4% is a disagreement.
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
    edgeRequestBodyMaxSize: `${uploadCeilingMib / 2}MiB`,
    memoryLimit: `${rssBudgetMib + uploadCeilingMib}m`,
  };
}

/**
 * The private ranges an app host's address may come from.
 *
 * Checked against the address itself rather than against the port string the
 * address produced, which is the shape the runtime-posture check had and which
 * accepted `0.0.0.0` because the rendered port did begin with `0.0.0.0:`. A
 * check whose expectation is derived from its subject cannot fail.
 */
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8 -- the estate's own `10.20.1.0/24`
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

function ipv4ToInt(address: string): number | undefined {
  const octets = address.split('.');
  if (octets.length !== 4) return undefined;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined;
    const part = Number(octet);
    if (part > 255) return undefined;
    // Rejected rather than normalised: a leading zero is read as octal by some
    // parsers and as decimal by others, so `010.20.1.100` is two different
    // hosts depending on who resolves it.
    if (octet.length > 1 && octet.startsWith('0')) return undefined;
    value = value * 256 + part;
  }
  return value;
}

/**
 * Refuses any address a tenant's port must not be published on.
 *
 * `0.0.0.0` is the one that matters and the one a self-referential check
 * misses: it puts a tenant's Ghost on the app host's public interface, behind
 * nothing but a Hetzner firewall rule, which §18's network posture exists to
 * prevent. Loopback is refused too, for the opposite reason -- the edge could
 * never reach it, so a stack bound there is a site that silently never serves.
 */
export function validateAppHostPrivateIp(address: string): void {
  const value = ipv4ToInt(address);
  if (value === undefined) {
    throw new Error(
      `GhostTenant: appHostPrivateIp "${address}" is not a dotted-quad IPv4 address.`
    );
  }
  if (!PRIVATE_IPV4_RANGES.some(([low, high]) => value >= low && value <= high)) {
    throw new Error(
      `GhostTenant: appHostPrivateIp "${address}" is not in a private IPv4 range. Publishing a ` +
        `tenant anywhere else puts it on the app host's public interface, behind nothing but a ` +
        `firewall rule.`
    );
  }
}

/** The host-side port a tenant's Ghost is published on. */
export function validateHostPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `GhostTenant: hostPort ${port} must be an integer in 1024-65535. Below 1024 it would collide ` +
        `with a privileged service on a host that already runs SSH.`
    );
  }
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
