/**
 * Shared by the `tenantEnvironment()` unit test and the sabotage case: asserts the
 * explicit Ghost SMTP timeouts that the queue transport renders with mail enabled.
 */
import { expect } from 'vitest';

const EXPECTED_TIMEOUTS: Readonly<Record<string, number>> = {
  mail__options__connectionTimeout: 5000,
  mail__options__greetingTimeout: 5000,
  mail__options__socketTimeout: 10000,
};

const MINIMUM_MS = 1000;
const MAXIMUM_MS = 10000;

export function assertQueueMailTimeouts(environment: Record<string, string | number | boolean>): void {
  for (const [key, expected] of Object.entries(EXPECTED_TIMEOUTS)) {
    const value = environment[key];
    expect(value, key).toBe(expected);
    expect(typeof value, key).toBe('number');
    expect(Number.isInteger(value), key).toBe(true);
    expect(value as number, key).toBeGreaterThanOrEqual(MINIMUM_MS);
    expect(value as number, key).toBeLessThanOrEqual(MAXIMUM_MS);
  }
}
