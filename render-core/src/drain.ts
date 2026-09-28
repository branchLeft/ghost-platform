/**
 * The drain list mx1's collector reads: a host not in the descriptor set is
 * a host mx1 will not collect mail from. Operates on a whole fleet at once,
 * unlike `render()`. See drain.md#the-drain-list.
 */

import type { TenantDescriptor } from './descriptor.js';

/**
 * The distinct app-host addresses of every given descriptor with
 * `mail.enabled`, sorted for a deterministic diff. A demo host running many
 * slots, or an app host running many paying tenants, contributes exactly
 * one entry — mx1 drains a host once, not once per tenant on it.
 */
export function renderDrainList(
  descriptors: readonly Pick<TenantDescriptor, 'appHostIp' | 'mail'>[]
): readonly string[] {
  const hosts = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.mail.enabled) {
      hosts.add(descriptor.appHostIp);
    }
  }
  return [...hosts].sort();
}
