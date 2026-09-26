import { describe, expect, it } from 'vitest';
import { createDeliveredTracker } from '../../src/dedupe.js';

describe('createDeliveredTracker', () => {
  it('has() is false before markDelivered and true after', () => {
    const tracker = createDeliveredTracker(1000);
    expect(tracker.has('m1')).toBe(false);
    tracker.markDelivered('m1');
    expect(tracker.has('m1')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('sweep() evicts entries older than the TTL and keeps newer ones', () => {
    let now = 1000;
    const tracker = createDeliveredTracker(500, () => now);
    tracker.markDelivered('old');
    now = 1600; // 600ms later -- past the 500ms TTL
    tracker.markDelivered('new');
    tracker.sweep();
    expect(tracker.has('old')).toBe(false);
    expect(tracker.has('new')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('sweep() is a no-op when nothing has expired', () => {
    let now = 0;
    const tracker = createDeliveredTracker(10_000, () => now);
    tracker.markDelivered('m1');
    now = 100;
    tracker.sweep();
    expect(tracker.has('m1')).toBe(true);
  });
});
