import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * One message handed to Sweego. A recipient's complaint names a message only
 * by the correlation value we put on it, so this is the only record that can
 * tell a complaint about mail we sent from one that anyone with the webhook
 * secret could invent. See ../README.md#sweego-complaints-pulled-from-the-receiver.
 */
export interface SentEntry {
  /** The correlation value carried on the message (`outcomeIdFor`). */
  outcomeId: string;
  /** The spool the message was drained from: the only place its complaint may go. */
  targetId: string;
  id: string;
  drainCount: number;
  atMs: number;
}

export interface SentJournal {
  /**
   * Writes the entry down before returning. False when it could not be kept
   * (journal full, or the file could not be written): the message is still
   * sent, but a complaint about it will not match.
   */
  record(entry: Omit<SentEntry, 'outcomeId'>): boolean;
  /** The entry for a correlation value, or undefined for any value we never sent. */
  lookup(outcomeId: string): SentEntry | undefined;
  /** Forgets entries past the TTL. Called on a timer by the caller. */
  sweep(): void;
  readonly size: number;
}

export interface SentJournalOptions {
  /** File the entries are kept in, on a volume that outlives the process. Unset, memory only. */
  path?: string;
  /** How long an entry is kept: how long after a send a complaint can still be placed. */
  ttlMs: number;
  /** Most entries held. A full journal refuses new ones rather than forget old ones. */
  maxEntries?: number;
  now?: () => number;
  /** Called with a file failure; the journal never throws for one. */
  onError?: (error: Error) => void;
}

const FILE_VERSION = 1;
export const DEFAULT_SENT_JOURNAL_MAX_ENTRIES = 1_000_000;

/**
 * The value carried on a Sweego message and echoed back by a complaint:
 * the message id and its claim generation. Only characters the receiver
 * accepts (letters, digits, `.`, `-`).
 */
export function outcomeIdFor(key: { id: string; drainCount: number }): string {
  return `${key.id}.${key.drainCount}`;
}

function isEntry(value: unknown): value is SentEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.outcomeId === 'string' &&
    typeof v.targetId === 'string' &&
    typeof v.id === 'string' &&
    typeof v.drainCount === 'number' &&
    Number.isFinite(v.drainCount) &&
    typeof v.atMs === 'number' &&
    Number.isFinite(v.atMs) &&
    v.outcomeId === outcomeIdFor({ id: v.id, drainCount: v.drainCount })
  );
}

/**
 * Append-only newline-delimited JSON: a record costs one small fsynced write
 * however many entries are held, and a crash can tear only the last line,
 * which is skipped on load. The first line is a version header. Expired
 * entries are dropped, and the file rewritten whole and atomically, by `sweep`
 * and at load when anything was dropped.
 */
export function createSentJournal(options: SentJournalOptions): SentJournal {
  const { path, ttlMs, onError } = options;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_SENT_JOURNAL_MAX_ENTRIES;
  const entries = new Map<string, SentEntry>();
  // False once a file that exists could not be read or written without risking it.
  let writable = true;

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function lineOf(entry: SentEntry): string {
    return `${JSON.stringify(entry)}\n`;
  }

  function rewrite(): void {
    if (!path) {
      return;
    }
    try {
      const body = [
        `${JSON.stringify({ version: FILE_VERSION })}\n`,
        ...[...entries.values()].map(lineOf),
      ].join('');
      writeFileAtomic(path, body);
    } catch (error) {
      report(error);
    }
  }

  function load(file: string): void {
    if (!existsSync(file)) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      // Not overwritten: its bytes may still be readable by someone.
      writable = false;
      report(error);
      return;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const at = now();
    let dropped = 0;
    let version: unknown;
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn last line from a crash is expected; any other bad line is noted.
        if (index !== lines.length - 1) {
          report(new Error('sent journal has an unreadable line'));
        }
        dropped += 1;
        continue;
      }
      if (index === 0) {
        version = (parsed as { version?: unknown }).version;
        if (version !== FILE_VERSION) {
          writable = false;
          report(new Error('sent journal has an unrecognised version'));
          return;
        }
        continue;
      }
      if (!isEntry(parsed)) {
        report(new Error('sent journal has an unrecognised entry'));
        dropped += 1;
        continue;
      }
      if (at - parsed.atMs >= ttlMs) {
        dropped += 1;
        continue;
      }
      entries.set(parsed.outcomeId, parsed);
    }
    if (dropped > 0 && writable) {
      rewrite();
    }
  }

  if (path) {
    load(path);
  }

  return {
    record(entry) {
      const full: SentEntry = { ...entry, outcomeId: outcomeIdFor(entry) };
      if (entries.has(full.outcomeId)) {
        return true;
      }
      if (entries.size >= maxEntries) {
        report(new Error('sent journal is full'));
        return false;
      }
      if (path) {
        if (!writable) {
          report(new Error('sent journal file is not writable'));
          return false;
        }
        try {
          const fresh = !existsSync(path);
          mkdirSync(dirname(path), { recursive: true });
          const fd = openSync(path, 'a', 0o600);
          try {
            if (fresh) {
              writeSync(fd, `${JSON.stringify({ version: FILE_VERSION })}\n`);
            }
            writeSync(fd, lineOf(full));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch (error) {
          report(error);
          return false;
        }
      }
      entries.set(full.outcomeId, full);
      return true;
    },
    lookup(outcomeId) {
      const entry = entries.get(outcomeId);
      return entry ? { ...entry } : undefined;
    },
    sweep() {
      const at = now();
      let removed = 0;
      for (const [key, entry] of entries) {
        if (at - entry.atMs >= ttlMs) {
          entries.delete(key);
          removed += 1;
        }
      }
      if (removed > 0 && writable) {
        rewrite();
      }
    },
    get size(): number {
      return entries.size;
    },
  };
}
