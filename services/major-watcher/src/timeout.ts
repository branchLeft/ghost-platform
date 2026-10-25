// Per-request deadlines for outbound calls. AbortSignal.timeout throws a RangeError for a fraction or a
// value above 4294967295 and aborts at once for 2147483648 to 4294967295, so only whole milliseconds
// from 1 to 2147483647 are accepted and anything else falls back to the caller's default.
export const MAX_TIMEOUT_MS = 2147483647;

export function resolveTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_MS
    ? value
    : fallback;
}

// The request failed. If this request's own signal has aborted it was the deadline, so say so with a
// message that names only the operation and the limit; any other failure is rethrown unchanged.
export function rethrowOrTimeout(
  signal: AbortSignal,
  timeoutMessage: string,
  error: unknown
): never {
  if (signal.aborted) throw new Error(timeoutMessage);
  throw error;
}
