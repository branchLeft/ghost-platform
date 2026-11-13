/** In-memory counters, read on the drain port. Counts only: no ids, no addresses. */
export type StatName =
  | 'accepted'
  | 'rejected_signature'
  | 'rejected_window'
  | 'rejected_oversize'
  | 'replayed'
  | 'ignored_event_type'
  | 'ignored_unparseable'
  | 'ignored_no_outcome_id'
  | 'unavailable';

export interface Stats {
  increment(name: StatName): void;
  snapshot(): Record<StatName, number>;
}

export function createStats(): Stats {
  const counts: Record<StatName, number> = {
    accepted: 0,
    rejected_signature: 0,
    rejected_window: 0,
    rejected_oversize: 0,
    replayed: 0,
    ignored_event_type: 0,
    ignored_unparseable: 0,
    ignored_no_outcome_id: 0,
    unavailable: 0,
  };
  return {
    increment(name) {
      counts[name] += 1;
    },
    snapshot() {
      return { ...counts };
    },
  };
}
