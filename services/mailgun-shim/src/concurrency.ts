/**
 * Runs `worker` over `items` with at most `limit` in flight at once. Used to
 * submit a batch's recipients to the delivery host without opening 1,000
 * simultaneous SMTP connections (doc 13 §2.4 point 2) or serialising them
 * one at a time.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) {
      return;
    }
    results[index] = await worker(items[index] as T, index);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}
