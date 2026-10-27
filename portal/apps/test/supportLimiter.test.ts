import { describe, expect, it } from 'vitest';
import {
  MAX_TICKETS_PER_WINDOW,
  SupportLimiter,
  WINDOW_SECONDS,
} from '../src/tenant/supportLimiter.js';

function limiterAt(start: number): { limiter: SupportLimiter; advance: (seconds: number) => void } {
  let now = start;
  return {
    limiter: new SupportLimiter(() => now),
    advance: (seconds) => {
      now += seconds;
    },
  };
}

describe('the ticket limit', () => {
  it('allows the limit and refuses the next ticket in the window', () => {
    const { limiter } = limiterAt(1000);
    for (let taken = 0; taken < MAX_TICKETS_PER_WINDOW; taken += 1) {
      expect(limiter.tryTake('tenant-a')).toBe(true);
    }
    expect(limiter.tryTake('tenant-a')).toBe(false);
  });

  it('keeps refusing until the window ends, then resets', () => {
    const { limiter, advance } = limiterAt(1000);
    for (let taken = 0; taken < MAX_TICKETS_PER_WINDOW; taken += 1) limiter.tryTake('tenant-a');
    advance(WINDOW_SECONDS - 1);
    expect(limiter.tryTake('tenant-a')).toBe(false);
    advance(1);
    expect(limiter.tryTake('tenant-a')).toBe(true);
  });

  it('counts each tenant on its own', () => {
    const { limiter } = limiterAt(1000);
    for (let taken = 0; taken < MAX_TICKETS_PER_WINDOW; taken += 1) limiter.tryTake('tenant-a');
    expect(limiter.tryTake('tenant-a')).toBe(false);
    expect(limiter.tryTake('tenant-b')).toBe(true);
  });

  it('forgets expired windows so the table cannot grow without bound', () => {
    const { limiter, advance } = limiterAt(1000);
    for (let tenant = 0; tenant < 50; tenant += 1) limiter.tryTake(`tenant-${tenant}`);
    expect(limiter.trackedTenants).toBe(50);
    advance(WINDOW_SECONDS);
    limiter.tryTake('tenant-late');
    expect(limiter.trackedTenants).toBe(1);
  });
});
