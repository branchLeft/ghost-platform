import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import { missingFileVerdict, presentFileTrust, writeMarker } from './stateMarker.js';
import type { StateWitness } from './stateWitness.js';

/**
 * Named `submitted`, not `delivered` -- LLD-6 M5: this tracker records
 * that mx1's SMTP front accepted the message, never that mx1 relayed or
 * it was actually delivered. See ../README.md#dedupe-submittedtracker.
 */
export interface SubmittedTracker {
  has(id: string): boolean;
  /**
   * `awaitingAck` keeps the id past the TTL until `markAcked` names it (or
   * MAX_AWAITING_ACK_MS passes): a batch can outlast the TTL at a low rate,
   * and an id swept before its ack lands would be sent again.
   */
  markSubmitted(id: string, awaitingAck?: boolean): void;
  /** The shim has taken these ids: they expire on the plain TTL, counted from now. */
  markAcked(ids: readonly string[]): void;
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
  /** Witness kept on a different mount from `statePath`. Absent, only the marker beside the file guards it. */
  witness?: StateWitness;
  /** Called with a state-file read or write failure; the tracker never throws for one. */
  onError?: (error: Error) => void;
}

const STATE_VERSION = 1;

/** The most an id may wait for its ack before it is dropped anyway, so an id the shim never acknowledges cannot be held forever. */
export const MAX_AWAITING_ACK_MS = 14 * 24 * 60 * 60 * 1000;

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
  const { statePath, witness, onError } = options;
  const submittedAt = new Map<string, number>();
  const awaitingAck = new Set<string>();
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
      } else {
        const verdict = missingFileVerdict(path, witness);
        if (verdict !== 'first-run') {
          // Written before, so not a first run: the file has vanished and the ids
          // it held are forgotten. Recorded in the file, as for a corrupt one.
          // The marker and witness are written again with it.
          markerKnown = false;
          lostAt = now();
          report(
            new Error(
              verdict === 'vanished'
                ? 'dedupe state file is missing though it was written before'
                : 'dedupe state file is missing and its witness remembers it: the volume was replaced'
            )
          );
          persist(path);
        }
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        submitted?: unknown;
        awaitingAck?: unknown;
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
      // Absent in a file written before ids could wait for an ack: those load as acked.
      if (Array.isArray(parsed.awaitingAck)) {
        for (const id of parsed.awaitingAck) {
          if (typeof id === 'string' && submittedAt.has(id)) {
            awaitingAck.add(id);
          }
        }
      }
      if (typeof parsed.lostAt === 'number' && Number.isFinite(parsed.lostAt)) {
        lostAt = parsed.lostAt;
      }
      const trust = presentFileTrust(path, witness);
      if (trust === 'witness-lost') {
        // The witness no longer vouches for this file: the volume may be an old
        // copy or a stand-in, so what it holds is not to be relied on.
        markerKnown = false;
        lostAt = now();
        report(new Error('dedupe state file is no longer vouched for by its witness'));
        persist(path);
      } else if (trust === 'unmarked') {
        // A file from before the marker or witness existed: write them now, so the file's later loss is seen.
        writeMarkerOnce(path);
      } else {
        markerKnown = true;
      }
    } catch (error) {
      submittedAt.clear();
      awaitingAck.clear();
      lostAt = now();
      report(error);
      // Recorded in the file, so a restart does not read the empty state as a clean one.
      persist(path);
    }
  }

  function persist(path: string): void {
    try {
      writeFileAtomic(
        path,
        JSON.stringify({
          version: STATE_VERSION,
          submitted: Object.fromEntries(submittedAt),
          awaitingAck: [...awaitingAck],
          ...(lostAt === undefined ? {} : { lostAt }),
        })
      );
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
      writeMarker(path, witness);
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
    markSubmitted(id: string, awaiting = false): void {
      submittedAt.set(id, now());
      if (awaiting) {
        awaitingAck.add(id);
      } else {
        awaitingAck.delete(id);
      }
      if (statePath) {
        persist(statePath);
      }
    },
    markAcked(ids: readonly string[]): void {
      let changed = false;
      for (const id of ids) {
        if (submittedAt.has(id)) {
          submittedAt.set(id, now());
          awaitingAck.delete(id);
          changed = true;
        }
      }
      if (changed && statePath) {
        persist(statePath);
      }
    },
    sweep(): void {
      const nowMs = now();
      let evicted = false;
      for (const [id, at] of submittedAt) {
        const bound = awaitingAck.has(id) ? MAX_AWAITING_ACK_MS : ttlMs;
        if (at < nowMs - bound) {
          submittedAt.delete(id);
          awaitingAck.delete(id);
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
