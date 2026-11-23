import { randomBytes } from 'node:crypto';
import { MEDIA_PLACEHOLDER_NAMES } from './plan.js';

/**
 * Bucket keys for a tenant whose media is `s3` and whose real keys have not arrived. The slot boots
 * and uploads are refused; real keys come through the storage gateway, never by hand. Each value is
 * random (so no two tenants share one) and starts with `PLACEHOLDER_MARK`, so anything holding one
 * can be told from a real key by reading it. The plan names the secrets (`MEDIA_PLACEHOLDER_NAMES`)
 * and never carries a value.
 */
export const PLACEHOLDER_MARK = 'PLACEHOLDER-';

const VALUE_BYTES = 16;

export const isPlaceholder = (value: string): boolean => value.startsWith(PLACEHOLDER_MARK);

/** One marked random value for each placeholder secret name. */
export function generatePlaceholderMediaValues(): Record<string, string> {
  return Object.fromEntries(
    MEDIA_PLACEHOLDER_NAMES.map((name) => [
      name,
      `${PLACEHOLDER_MARK}${randomBytes(VALUE_BYTES).toString('hex')}`,
    ])
  );
}
