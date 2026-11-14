import type {
  ListQuery,
  OutcomeProvider,
  ProviderRecord,
} from '../../src/sweegoOutcomes/poller.js';
import { utcDate } from '../../src/sweegoOutcomes/poller.js';

/**
 * A provider double with the log listing's shape: filtered by day, paged by
 * offset, and able to fail. It holds records only; it never sees a
 * credential and opens no connection.
 */
export interface FakeSweegoProvider extends OutcomeProvider {
  add(record: ProviderRecord): void;
  /** The next call rejects with this error. */
  failNext(error: Error): void;
  readonly queries: ListQuery[];
}

export function createFakeSweegoProvider(): FakeSweegoProvider {
  const records: ProviderRecord[] = [];
  const queries: ListQuery[] = [];
  let failure: Error | null = null;
  return {
    queries,
    add: (record) => {
      records.push(record);
    },
    failNext: (error) => {
      failure = error;
    },
    async list(query) {
      queries.push({ ...query });
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      return records
        .filter((r) => {
          const day = utcDate(r.createdAtMs);
          return day >= query.fromDate && day <= query.toDate;
        })
        .slice(query.offset, query.offset + query.size);
    },
  };
}
