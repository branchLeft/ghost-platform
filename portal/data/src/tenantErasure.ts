/**
 * A tenant's own request to erase its whole site.
 *
 * The portal records the request and records that the tenant's backup key has
 * been destroyed; it destroys nothing itself (nothing under `portal/` can reach
 * a host). The key is destroyed by `erase_tenant_backup_identity.py`, run on the
 * control host, and the portal learns of it only from that command's own
 * green proof line (see the owner console's erasure recorder). Until it does,
 * the request is `requested` and the page says nothing has been erased.
 *
 * After the key is destroyed the data is not gone at that moment: the backup
 * ciphertext stays in the stores and the shared binary-log stream is only
 * retention-bounded. The residual window is about 46 days and has no upper
 * bound, because the pruner never deletes the anchor dump however old it is, so
 * a run of failed nightly dumps stretches it. Both facts are constants here and
 * travel together; no value derived from the clock can read as an end date.
 */

/** A request is `requested` until the key is destroyed; nothing moves it back, and nothing deletes it. */
export const ERASURE_STATUSES = ['requested', 'key_destroyed'] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

/** The residual window's usual length, in days, from the moment the key is destroyed. */
export const ERASURE_RESIDUAL_AROUND_DAYS = 46;

/** Why the window has no upper bound. A code, so the page words it as owner-supplied copy. */
export const ERASURE_RESIDUAL_REASON = 'ANCHOR_DUMP_NEVER_PRUNED';

/**
 * The honest residual window, stated once. `upperBoundDays` is `null` and is
 * typed `null`, not `number`: there is no bound the pruner's behaviour supports,
 * so no value can be put there.
 */
export interface ResidualWindow {
  readonly aroundDays: typeof ERASURE_RESIDUAL_AROUND_DAYS;
  readonly upperBoundDays: null;
  readonly reason: typeof ERASURE_RESIDUAL_REASON;
}

export const RESIDUAL_WINDOW: ResidualWindow = {
  aroundDays: ERASURE_RESIDUAL_AROUND_DAYS,
  upperBoundDays: null,
  reason: ERASURE_RESIDUAL_REASON,
};

/** What the tenant page and the console show about a tenant's erasure request. */
export type ErasureView =
  | { readonly state: 'none' }
  | { readonly state: 'requested'; readonly requestedAt: Date }
  | {
      readonly state: 'key_destroyed';
      readonly requestedAt: Date;
      readonly keyDestroyedAt: Date;
      readonly residual: ResidualWindow;
    };

interface StoredErasure {
  readonly status: string;
  readonly requestedAt: Date;
  readonly keyDestroyedAt: Date | null;
}

/**
 * A stored request as it is shown. `key_destroyed` is returned only when the
 * row says so and carries the moment the key was destroyed; a row that says it
 * without the moment, and a status outside the closed list, are both shown as
 * `requested`, because the page must never say more than the record proves.
 */
export function deriveErasureView(row: StoredErasure | null): ErasureView {
  if (row === null) return { state: 'none' };
  if (row.status === 'key_destroyed' && row.keyDestroyedAt !== null) {
    return {
      state: 'key_destroyed',
      requestedAt: row.requestedAt,
      keyDestroyedAt: row.keyDestroyedAt,
      residual: RESIDUAL_WINDOW,
    };
  }
  return { state: 'requested', requestedAt: row.requestedAt };
}

/** One tenant's request as the owner console lists it. */
export interface ErasureRequestView {
  readonly tenantId: string;
  readonly view: Exclude<ErasureView, { state: 'none' }>;
}
