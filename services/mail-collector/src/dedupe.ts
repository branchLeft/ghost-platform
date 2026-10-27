import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Named `submitted`, not `delivered` -- LLD-6 M5: this tracker records
 * that mx1's SMTP front accepted the message, never that mx1 relayed or
 * it was actually delivered. See ../README.md#dedupe-submittedtracker.
 */
export interface SubmittedTracker {
  has(id: string): boolean;
  markSubmitted(id: string): void;
  /** Drops entries older than the configured TTL. Called on a timer by the caller, not internally, so tests can drive it deterministically. */
  sweep(): void;
  readonly size: number;
}

export interface SubmittedTrackerOptions {
  /**
   * File the submitted ids are kept in, on a volume that outlives the
   * process. Unset, the tracker is memory-only and a restart forgets
   * every id.
   */
  statePath?: string;
  /** Called with a state-file read or write failure; the tracker never throws for one. */
  onError?: (error: Error) => void;
}

const STATE_VERSION = 1;

/**
 * Turns the shim's at-least-once drain into at-most-one submission at mx1
 * per id for as long as the entry lives: a re-offer of an already-handed-off
 * id is skipped, only re-acked. Bounded by a TTL long enough to outlast a
 * plausible re-offer window.
 *
 * With `statePath` the ids survive a restart. The write-after-accept ordering
 * and its residual duplicate window are in ../README.md (dedupe, state file).
 * See ../README.md#dedupe-createsubmittedtracker.
 */
export function createSubmittedTracker(
  ttlMs: number,
  now: () => number = Date.now,
  options: SubmittedTrackerOptions = {}
): SubmittedTracker {
  const { statePath, onError } = options;
  const submittedAt = new Map<string, number>();

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        report(error);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; submitted?: unknown };
      if (
        parsed.version !== STATE_VERSION ||
        typeof parsed.submitted !== 'object' ||
        parsed.submitted === null
      ) {
        throw new Error('dedupe state file has an unrecognised shape');
      }
      for (const [id, at] of Object.entries(parsed.submitted)) {
        if (typeof at === 'number' && Number.isFinite(at)) {
          submittedAt.set(id, at);
        }
      }
    } catch (error) {
      submittedAt.clear();
      report(error);
    }
  }

  // Write-to-temp, fsync, rename, fsync the directory: a crash at any point
  // leaves either the previous complete file or the new complete one, never
  // a torn file that would load as empty and forget every id.
  function persist(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const body = JSON.stringify({
        version: STATE_VERSION,
        submitted: Object.fromEntries(submittedAt),
      });
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      const dirFd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      report(error);
    }
  }

  if (statePath) {
    load(statePath);
  }

  return {
    has(id: string): boolean {
      return submittedAt.has(id);
    },
    markSubmitted(id: string): void {
      submittedAt.set(id, now());
      if (statePath) {
        persist(statePath);
      }
    },
    sweep(): void {
      const cutoff = now() - ttlMs;
      let evicted = false;
      for (const [id, at] of submittedAt) {
        if (at < cutoff) {
          submittedAt.delete(id);
          evicted = true;
        }
      }
      if (evicted && statePath) {
        persist(statePath);
      }
    },
    get size(): number {
      return submittedAt.size;
    },
  };
}
