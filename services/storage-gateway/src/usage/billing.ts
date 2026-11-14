/** Hetzner bills object bytes in units of 64 KiB. */
export const BILLABLE_UNIT_BYTES = 64 * 1024;

/** The bytes billed for a transfer of `bytes`: rounded up to a whole unit, and nothing for nothing. */
export function billableBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('a byte count must be a non-negative whole number');
  }
  return Math.ceil(bytes / BILLABLE_UNIT_BYTES) * BILLABLE_UNIT_BYTES;
}
