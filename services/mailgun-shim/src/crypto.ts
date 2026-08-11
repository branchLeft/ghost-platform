import { createHash } from 'node:crypto';

// Tenant keys are looked up by hash, never compared in plaintext or stored
// in plaintext — the store is the blast radius doc 13 §2.6 asks us to keep
// small per tenant.
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}
