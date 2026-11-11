import { InvalidRunOptionsError } from './errors.js';
import type { RetryPolicy } from './executePorts.js';

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

const isCount = (n: number, min: number): boolean => Number.isInteger(n) && n >= min;

/** Names the fields of a policy that cannot be used; a bad policy is refused, never clamped. */
export function resolveRetry(policy: RetryPolicy = DEFAULT_RETRY): RetryPolicy {
  const bad: string[] = [];
  if (!isCount(policy.maxAttempts, 1)) bad.push('maxAttempts');
  if (!isCount(policy.baseDelayMs, 0)) bad.push('baseDelayMs');
  if (!isCount(policy.maxDelayMs, 0) || policy.maxDelayMs < policy.baseDelayMs) {
    bad.push('maxDelayMs');
  }
  if (bad.length > 0) throw new InvalidRunOptionsError(bad);
  return policy;
}

/** The wait after the given failed attempt (1-based): doubling, capped. */
export const delayFor = (attempt: number, policy: RetryPolicy): number =>
  Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
