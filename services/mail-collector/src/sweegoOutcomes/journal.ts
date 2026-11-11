import type { MessageState, OutcomeDetail, ReportKind } from './stateMachine.js';

/** One message submitted to Sweego whose outcome is still owed or recently settled. */
export interface JournalEntry {
  id: string;
  drainCount: number;
  /** The spool the message was drained from; the only place its outcome may go. */
  targetId: string;
  submittedAtMs: number;
  state: MessageState;
  detail: OutcomeDetail;
  /** The last report the spool answered for; null until it has. */
  reported: ReportKind | null;
  /** Set when the provider's retention ran out before a final word was read. */
  lostToRetention: boolean;
  updatedAtMs: number;
}

export function journalKey(entry: { id: string; drainCount: number }): string {
  return `${entry.id}.${entry.drainCount}`;
}

/** What the poller reads on each pass; a persistent implementation replaces the in-memory one. */
export interface OutcomeJournal {
  list(): JournalEntry[];
  get(key: string): JournalEntry | undefined;
  put(entry: JournalEntry): void;
  remove(key: string): void;
}

export interface PollCursor {
  /** When a scan last read every page of its window without error; null before the first. */
  lastCompleteScanMs: number | null;
}

export interface CursorStore {
  read(): PollCursor;
  write(cursor: PollCursor): void;
}

export function createMemoryJournal(): OutcomeJournal {
  const entries = new Map<string, JournalEntry>();
  return {
    list: () => [...entries.values()].map((e) => ({ ...e, detail: { ...e.detail } })),
    get: (key) => {
      const e = entries.get(key);
      return e ? { ...e, detail: { ...e.detail } } : undefined;
    },
    put: (entry) => {
      entries.set(journalKey(entry), { ...entry, detail: { ...entry.detail } });
    },
    remove: (key) => {
      entries.delete(key);
    },
  };
}

export function createMemoryCursorStore(): CursorStore {
  let cursor: PollCursor = { lastCompleteScanMs: null };
  return {
    read: () => ({ ...cursor }),
    write: (next) => {
      cursor = { ...next };
    },
  };
}
