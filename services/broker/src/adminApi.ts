import type { SlotName, TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/**
 * configure() must be called, in order, between starting the unit and
 * clearing the drain flag; a failure here routes through the same
 * reset-and-retry path as every other reconcile failure.
 * See adminApi.md#why-this-shape.
 */
export interface AdminApiClient {
  configure(baseUrl: string, descriptor: TenantDescriptor, slot: SlotName): Promise<void>;
  /** Drops whatever this client keeps for `slot`; called once a reset has wiped it. */
  forget?(slot: SlotName): Promise<void>;
}
