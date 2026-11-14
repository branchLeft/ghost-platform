// Stops an import when its first batch bounces hard above 5 percent.

export const HARD_BOUNCE_LIMIT_PERCENT = 5;

export interface BatchEvidence {
  readonly sent: number;
  readonly hardBounces: number;
}

export interface BatchVerdict {
  readonly decision: 'continue' | 'stop';
  readonly bouncePercent: number | null;
}

export function evaluateFirstBatch({ sent, hardBounces }: BatchEvidence): BatchVerdict {
  if (!Number.isSafeInteger(sent) || sent < 0) {
    throw new RangeError('sent must be a non-negative integer');
  }
  if (!Number.isSafeInteger(hardBounces) || hardBounces < 0 || hardBounces > sent) {
    throw new RangeError('hardBounces must be an integer from 0 to sent');
  }
  const bouncePercent = sent === 0 ? null : (hardBounces * 100) / sent;
  // Compared in integers so that exactly 5.0 percent does not stop.
  const stop = hardBounces * 100 > HARD_BOUNCE_LIMIT_PERCENT * sent;
  return { decision: stop ? 'stop' : 'continue', bouncePercent };
}
