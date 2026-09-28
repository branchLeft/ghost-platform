import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/**
 * configure() must be called, in order, between starting the unit and
 * clearing the drain flag; a failure here routes through the same
 * reset-and-retry path as every other reconcile failure.
 * See adminApi.md#why-this-shape.
 */
export interface AdminApiClient {
  configure(baseUrl: string, descriptor: TenantDescriptor): Promise<void>;
}
