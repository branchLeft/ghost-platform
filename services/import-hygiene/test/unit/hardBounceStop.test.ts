import { describe, expect, it } from 'vitest';
import { evaluateFirstBatch } from '../../src/hardBounceStop.js';

describe('evaluateFirstBatch', () => {
  it('continues on a zero-size batch with no percentage', () => {
    expect(evaluateFirstBatch({ sent: 0, hardBounces: 0 })).toEqual({
      decision: 'continue',
      bouncePercent: null,
    });
  });

  it('stops on a tiny batch where one bounce is above 5 percent', () => {
    expect(evaluateFirstBatch({ sent: 1, hardBounces: 1 }).decision).toBe('stop');
  });

  it('continues on a tiny batch with no bounce', () => {
    expect(evaluateFirstBatch({ sent: 1, hardBounces: 0 }).decision).toBe('continue');
  });

  it('does not stop at exactly 5.0 percent', () => {
    expect(evaluateFirstBatch({ sent: 20, hardBounces: 1 })).toEqual({
      decision: 'continue',
      bouncePercent: 5,
    });
    expect(evaluateFirstBatch({ sent: 1000, hardBounces: 50 }).decision).toBe('continue');
  });

  it('stops at 5.1 percent', () => {
    expect(evaluateFirstBatch({ sent: 1000, hardBounces: 51 }).decision).toBe('stop');
  });

  it('reports the bounce percentage', () => {
    expect(evaluateFirstBatch({ sent: 200, hardBounces: 7 }).bouncePercent).toBeCloseTo(3.5);
  });

  it('refuses hard bounces above the batch size', () => {
    expect(() => evaluateFirstBatch({ sent: 2, hardBounces: 3 })).toThrow(RangeError);
  });

  it('refuses a negative or fractional count', () => {
    expect(() => evaluateFirstBatch({ sent: -1, hardBounces: 0 })).toThrow(RangeError);
    expect(() => evaluateFirstBatch({ sent: 10, hardBounces: 0.5 })).toThrow(RangeError);
  });
});
