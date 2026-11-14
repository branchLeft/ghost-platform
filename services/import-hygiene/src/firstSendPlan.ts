// Orders an accepted list for its first sends: engaged members first when
// engagement data exists, and each batch at most floor(share x day cap).

export const DEFAULT_SHARE = 0.25;

export interface FirstSendOptions {
  readonly accepted: readonly string[];
  readonly engagement?: ReadonlyMap<string, number>;
  readonly dayCap: number;
  readonly share?: number;
}

export interface FirstSendPlan {
  readonly batchSize: number;
  readonly batches: readonly (readonly string[])[];
}

function orderByEngagement(
  accepted: readonly string[],
  engagement: ReadonlyMap<string, number> | undefined
) {
  if (engagement === undefined || engagement.size === 0) {
    return [...accepted];
  }
  const score = (address: string): number =>
    engagement.get(address.toLowerCase()) ?? Number.NEGATIVE_INFINITY;
  // Array sort is stable, so equal scores keep the caller's order.
  return [...accepted].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa === sb) {
      return 0;
    }
    return sa > sb ? -1 : 1;
  });
}

export function planFirstSends(options: FirstSendOptions): FirstSendPlan {
  const share = options.share ?? DEFAULT_SHARE;
  if (!Number.isInteger(options.dayCap) || options.dayCap < 0) {
    throw new RangeError('dayCap must be a non-negative integer');
  }
  if (!(share > 0 && share <= 1)) {
    throw new RangeError('share must be above 0 and at most 1');
  }
  // toFixed strips binary noise (0.29 x 100 is 28.999... in floating point).
  const batchSize = Math.floor(Number((share * options.dayCap).toFixed(9)));
  const ordered = orderByEngagement(options.accepted, options.engagement);
  if (ordered.length === 0) {
    return { batchSize, batches: [] };
  }
  if (batchSize < 1) {
    throw new RangeError('dayCap is too small for a batch of at least one member');
  }
  const batches: string[][] = [];
  for (let start = 0; start < ordered.length; start += batchSize) {
    batches.push(ordered.slice(start, start + batchSize));
  }
  return { batchSize, batches };
}
