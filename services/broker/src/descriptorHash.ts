import { createHash } from 'node:crypto';
import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/** Deep, key-sorted so two descriptors that differ only in key order still hash equal. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * LLD-2 §04: "Reconcile is idempotent on (slot, descriptorHash)." This is
 * that hash -- content-addressed so a byte-identical retry after a network
 * timeout is recognised as the same request regardless of key order in the
 * JSON the caller happened to send.
 */
export function descriptorHash(descriptor: TenantDescriptor): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(descriptor)))
    .digest('hex');
}
