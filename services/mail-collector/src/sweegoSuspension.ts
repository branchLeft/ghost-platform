import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import { markerAbsent, missingFileVerdict, presentFileTrust, writeMarker } from './stateMarker.js';
import type { StateWitness } from './stateWitness.js';
import type { CountedFailureReason } from './sweegoFailure.js';

/**
 * Why the suspension latch did something, as a label. A reason names an event
 * and nothing else: never a tenant, an address or a subject.
 */
export type SuspensionReason =
  /** Thirty minutes of authentication or credential refusals, with no acceptance between them. */
  | 'suspension-latched'
  /** The owner's file appeared: Sweego is off while it exists. */
  | 'suspension-owner-file'
  /** The owner deleted the marker: the latch was cleared. */
  | 'suspension-cleared'
  /** The state file could not be parsed: treated as suspended. */
  | 'suspension-state-corrupt'
  /** The state file exists but could not be read: treated as suspended. */
  | 'suspension-state-unreadable'
  /** The state file is missing though it was written before: treated as suspended. */
  | 'suspension-state-vanished'
  /** The witness on the other mount disagrees with the volume: treated as suspended. */
  | 'suspension-witness-mismatch'
  /** The state file could not be written: the latch holds in memory and the write is retried. */
  | 'suspension-write-failed';

/** How long refusals must run unbroken before Sweego is latched off. */
export const SUSPENSION_WINDOW_MS = 30 * 60 * 1000;

/** What the collector loop tells the latch about each Sweego attempt. */
export interface SweegoSuspensionRecorder {
  /** A Sweego attempt failed. Only `auth` and `credential` count towards a run; any other reason changes nothing. */
  recordRefusal(reason: CountedFailureReason): void;
  /** Sweego accepted a message: any run of refusals ends. */
  recordAcceptance(): void;
}

export interface SuspensionState {
  suspended: boolean;
  /** The owner's file exists. */
  ownerFile: boolean;
  /** When the latch was set, in epoch milliseconds. Absent while not latched. */
  since: number | undefined;
  /** When the current run of refusals began. Absent when there is no run. */
  runStart: number | undefined;
}

export interface SweegoSuspension extends SweegoSuspensionRecorder {
  suspended(): boolean;
  state(): SuspensionState;
  /** Counts of reasons since this process started. */
  reasons(): Readonly<Partial<Record<SuspensionReason, number>>>;
}

export interface SweegoSuspensionOptions {
  /** File on a volume that outlives the process. */
  statePath: string;
  /** A file the owner creates to switch Sweego off; Sweego is off while it exists. */
  ownerFilePath?: string;
  /** Injectable so a test crosses the window without waiting. */
  now?: () => number;
  /** Witness kept on a different mount from `statePath`. */
  witness?: StateWitness;
  onReason?: (reason: SuspensionReason) => void;
}

const STATE_VERSION = 1;

interface LoadedSuspension {
  suspended: boolean;
  since: number | undefined;
}

function parseState(raw: string): LoadedSuspension | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { version, suspended, since } = parsed as Record<string, unknown>;
  if (version !== STATE_VERSION || typeof suspended !== 'boolean') {
    return undefined;
  }
  if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since))) {
    return undefined;
  }
  return { suspended, since: since as number | undefined };
}

/**
 * Latches Sweego off after a run of refusals, or while the owner's file
 * exists. The latch is written to a state file with the marker and witness the
 * usage file uses: a month roll never touches it, and only the owner deleting
 * the marker clears it. Anything that makes the state unknown reads as
 * suspended, toward mx1. See ../README.md#sweegosuspension-createsweegosuspension.
 */
export function createSweegoSuspension(options: SweegoSuspensionOptions): SweegoSuspension {
  const { statePath, ownerFilePath, witness } = options;
  const now = options.now ?? Date.now;
  const reasonCounts: Partial<Record<SuspensionReason, number>> = {};
  let latched = false;
  let since: number | undefined;
  let runStart: number | undefined;
  let markerKnown = false;
  let unpersisted = false;
  let ownerFileSeen = false;

  function note(reason: SuspensionReason): void {
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    options.onReason?.(reason);
  }

  function persist(): void {
    try {
      // A latch written where the marker is absent goes marker first: a file
      // that says suspended beside no marker reads as the owner's clearing.
      if (latched && !markerKnown && markerAbsent(statePath)) {
        writeMarker(statePath, witness);
        markerKnown = true;
      }
      writeFileAtomic(
        statePath,
        JSON.stringify({
          version: STATE_VERSION,
          suspended: latched,
          ...(latched && since !== undefined ? { since } : {}),
        })
      );
      if (!markerKnown) {
        writeMarker(statePath, witness);
        markerKnown = true;
      }
      unpersisted = false;
    } catch {
      unpersisted = true;
      note('suspension-write-failed');
    }
  }

  function failClosed(reason: SuspensionReason): void {
    latched = true;
    since = now();
    markerKnown = false;
    note(reason);
    persist();
  }

  function load(): void {
    let raw: string;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        failClosed('suspension-state-unreadable');
        return;
      }
      const verdict = missingFileVerdict(statePath, witness);
      if (verdict !== 'first-run') {
        failClosed(
          verdict === 'vanished' ? 'suspension-state-vanished' : 'suspension-witness-mismatch'
        );
      }
      return;
    }
    const loaded = parseState(raw);
    if (loaded === undefined) {
      failClosed('suspension-state-corrupt');
      return;
    }
    const trust = presentFileTrust(statePath, witness);
    if (loaded.suspended && markerAbsent(statePath)) {
      // The owner deleted the marker: the latch is cleared.
      note('suspension-cleared');
      persist();
    } else if (loaded.suspended) {
      latched = true;
      since = loaded.since;
      markerKnown = trust === 'trusted';
    } else if (trust === 'witness-lost') {
      failClosed('suspension-witness-mismatch');
    } else if (trust === 'unmarked') {
      persist();
    } else {
      markerKnown = true;
    }
  }

  function ownerFileExists(): boolean {
    if (ownerFilePath === undefined) {
      return false;
    }
    let exists: boolean;
    try {
      statSync(ownerFilePath);
      exists = true;
    } catch (error) {
      // Anything but a plain absence reads as present, so doubt switches Sweego off.
      exists = (error as { code?: unknown }).code !== 'ENOENT';
    }
    if (exists && !ownerFileSeen) {
      note('suspension-owner-file');
    }
    ownerFileSeen = exists;
    return exists;
  }

  function latch(): void {
    latched = true;
    since = now();
    note('suspension-latched');
    persist();
  }

  load();

  return {
    suspended(): boolean {
      if (unpersisted) {
        persist();
      }
      return latched || ownerFileExists();
    },
    state(): SuspensionState {
      const ownerFile = ownerFileExists();
      return { suspended: latched || ownerFile, ownerFile, since, runStart };
    },
    recordRefusal(reason: CountedFailureReason): void {
      if (latched || (reason !== 'auth' && reason !== 'credential')) {
        return;
      }
      const at = now();
      runStart ??= at;
      if (at - runStart >= SUSPENSION_WINDOW_MS) {
        latch();
      }
    },
    recordAcceptance(): void {
      runStart = undefined;
    },
    reasons: () => ({ ...reasonCounts }),
  };
}
