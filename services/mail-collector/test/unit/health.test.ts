import { describe, expect, it } from 'vitest';
import { createHealthState } from '../../src/health.js';

describe('createHealthState', () => {
  it('starts healthy with zero consecutive failures', () => {
    const health = createHealthState();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.isHealthy(1)).toBe(true);
  });

  it('becomes unhealthy once consecutive failures reach the threshold', () => {
    const health = createHealthState();
    health.recordFailure();
    health.recordFailure();
    expect(health.consecutiveFailures).toBe(2);
    expect(health.isHealthy(2)).toBe(false); // AT the threshold -- unhealthy
    expect(health.isHealthy(3)).toBe(true); // below a higher threshold -- still healthy
  });

  it('a success resets the count, even after failures', () => {
    const health = createHealthState();
    health.recordFailure();
    health.recordFailure();
    health.recordFailure();
    health.recordSuccess();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.isHealthy(1)).toBe(true);
  });

  it('only consecutive failures count -- a success in between does not accumulate', () => {
    const health = createHealthState();
    health.recordFailure();
    health.recordSuccess();
    health.recordFailure();
    health.recordFailure();
    expect(health.consecutiveFailures).toBe(2);
  });
});
