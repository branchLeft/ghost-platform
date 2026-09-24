/**
 * The numbers that bound one tenant's Ghost container on a shared host,
 * derived from one input rather than set separately.
 *
 * Ported from `infra/tenant/runtime.ts` (LLD-1 §04: "Unchanged. Uid range,
 * upload limits and caps apply identically to all three kinds"). The uid
 * range and the resource-cap fields already live in `brand.ts` and
 * `descriptor.ts` — validated there, on the descriptor itself — so this
 * module keeps only the one thing that is not a descriptor field: the
 * upload-ceiling derivation, sized identically for every kind because no
 * descriptor field carries a tenant-specific ceiling to derive from
 * instead.
 */

export interface UploadLimits {
  /** `tmpfs: /tmp` `size=`. The backstop under everything below: a write
   * past it fails one upload with `ENOSPC` rather than taking the host
   * down. */
  readonly tmpfsSize: string;
  /** `theme__uploadLimits__compressedBytes`. */
  readonly themeCompressedBytes: number;
  /** `theme__uploadLimits__entryUncompressedBytes`. */
  readonly themeEntryUncompressedBytes: number;
  /** `theme__uploadLimits__totalUncompressedBytes`. */
  readonly themeTotalUncompressedBytes: number;
  /** The tenant's Caddy `request_body max_size` at the edge, in Caddy's own
   * size syntax — the only limit that bounds the upload paths Ghost leaves
   * unlimited. */
  readonly edgeRequestBodyMaxSize: string;
  /** `mem_limit` / `memswap_limit`: the RSS budget plus the tmpfs ceiling. */
  readonly memoryLimit: string;
}

/** Default upload ceiling, in MiB — see `infra/tenant/runtime.ts`'s own
 * comment for why Ghost's own defaults cannot be read off instead. */
export const DEFAULT_UPLOAD_CEILING_MIB = 128;

/** Resident-set budget for Ghost itself, in MiB, before the tmpfs is added. */
export const DEFAULT_RSS_BUDGET_MIB = 512;

const MIB = 1024 * 1024;
const MIN_UPLOAD_CEILING_MIB = 16;
const UPLOAD_CEILING_DIVISOR = 4;

/**
 * Derives every upload-related limit from one ceiling — see
 * `infra/tenant/runtime.ts`'s own comment for the proportions and why they
 * are not all equal to the ceiling. `render()` calls this with the default
 * ceiling for every kind, matching LLD-1 §04's "applies identically to all
 * three kinds": the schema carries no per-tenant override today.
 */
export function uploadLimits(
  uploadCeilingMib: number = DEFAULT_UPLOAD_CEILING_MIB,
  rssBudgetMib: number = DEFAULT_RSS_BUDGET_MIB
): UploadLimits {
  if (!Number.isInteger(uploadCeilingMib) || uploadCeilingMib < MIN_UPLOAD_CEILING_MIB) {
    throw new Error(
      `uploadCeilingMib must be an integer of at least ${MIN_UPLOAD_CEILING_MIB}, got ` +
        `${uploadCeilingMib}.`
    );
  }
  if (uploadCeilingMib % UPLOAD_CEILING_DIVISOR !== 0) {
    throw new Error(
      `uploadCeilingMib must be a multiple of ${UPLOAD_CEILING_DIVISOR} so every derived limit ` +
        `is a whole number of MiB, got ${uploadCeilingMib}.`
    );
  }
  if (!Number.isInteger(rssBudgetMib) || rssBudgetMib <= 0) {
    throw new Error(`rssBudgetMib must be a positive integer, got ${rssBudgetMib}.`);
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
