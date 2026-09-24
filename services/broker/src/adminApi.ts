import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/**
 * The Admin API step LLD-2 §03's `/reconcile` row names ("drive Ghost's
 * Admin API over loopback") without saying what it configures -- the
 * table's Does/Cannot columns are marked incidental in §03's own text, so
 * this is a deliberate seam rather than an omission this story needs to
 * resolve. No other design document specifies the call's content either
 * (LLD-1's descriptor carries no admin-setup fields beyond `ownerEmail`,
 * and Ghost's own first-run flow needs more than this schema states, e.g. a
 * password). What this story owns is that `/reconcile` calls it, in order,
 * between starting the unit and clearing the drain flag, and that a
 * failure here routes through the same reset-and-retry path every other
 * reconcile failure does.
 */
export interface AdminApiClient {
  configure(baseUrl: string, descriptor: TenantDescriptor): Promise<void>;
}
