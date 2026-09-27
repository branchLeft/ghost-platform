/**
 * The drain list mx1's collector reads (LLD-6 §09: "mx1's drain list is
 * derived from it, so a host that is not in the descriptor is a host mx1
 * will not collect mail from"). Unlike `render()`, this operates on a whole
 * fleet at once — a fleet-level reconciler's job, not the broker's or the
 * Pulumi component's per-tenant one — so it takes every descriptor the
 * caller currently holds, not one.
 *
 * Deliberately narrow: a host with no mail-enabled descriptor must never
 * appear, so this reads nothing but `appHostIp` and `mail.enabled` from
 * each descriptor, and returns nothing that was not derived from the list
 * it was given.
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
