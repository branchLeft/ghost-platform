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
import { markerAbsent, writeMarker } from './stateMarker.js';

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
  /**
   * True while the state file could not be trusted: it was corrupt, unreadable
   * or has vanished (missing, though it was written before) when loaded, so ids
   * it held are forgotten. Stays true for one
   * TTL after that, the time in which any forgotten id could still matter, and
   * survives a restart. A caller that must not act on a forgotten id holds the
   * message while this is set.
   */
  readonly stateLost: boolean;
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
 * per id for as long as its entry lives (bounded by a TTL): a re-offer is
 * skipped and only re-acked. With `statePath` the ids survive a restart.
 * An id is marked only after mx1 accepts it, never before, so a crash in
 * that gap can still duplicate one message.
 * See ../README.md#dedupe-createsubmittedtracker.
 */
export function createSubmittedTracker(
  ttlMs: number,
  now: () => number = Date.now,
  options: SubmittedTrackerOptions = {}
): SubmittedTracker {
  const { statePath, onError } = options;
  const submittedAt = new Map<string, number>();
  let lostAt: number | undefined;
  // True once the marker beside the file is known to exist: written after the
  // first successful save, or found at load. Without it a missing file is a first run.
  let markerKnown = false;

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        lostAt = now();
        report(error);
        persist(path);
      } else if (!markerAbsent(path)) {
        // Written before, so not a first run: the file has vanished and the ids
        // it held are forgotten. Recorded in the file, as for a corrupt one.
        markerKnown = true;
        lostAt = now();
        report(new Error('dedupe state file is missing though it was written before'));
        persist(path);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        submitted?: unknown;
        lostAt?: unknown;
      };
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
      if (typeof parsed.lostAt === 'number' && Number.isFinite(parsed.lostAt)) {
        lostAt = parsed.lostAt;
      }
      // A file from before the marker existed: write it now, so the file's later loss is seen.
      writeMarkerOnce(path);
    } catch (error) {
      submittedAt.clear();
      lostAt = now();
      report(error);
      // Recorded in the file, so a restart does not read the empty state as a clean one.
      persist(path);
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
        ...(lostAt === undefined ? {} : { lostAt }),
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
      writeMarkerOnce(path);
    } catch (error) {
      report(error);
    }
  }

  // After the file, not before: a crash between the two leaves a file with no
  // marker (read as an upgrade at the next load), never a marker with no file.
  function writeMarkerOnce(path: string): void {
    if (markerKnown) {
      return;
    }
    try {
      writeMarker(path);
      markerKnown = true;
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
    get stateLost(): boolean {
      return lostAt !== undefined && now() - lostAt < ttlMs;
    },
  };
}
