import { statSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * A state file that is missing is a first run only if it was never written.
 * The marker is a small file beside it, written once after the first
 * successful save: a missing file with the marker present has vanished (an
 * unmounted or wiped volume, a deleted file) and is not a first run. A marker
 * that cannot be told apart from present counts as present, so doubt reads as
 * a loss, never as a clean start. See ../README.md#state-markers.
 */

const MARKER_SUFFIX = '.initialised';

export function markerPathOf(statePath: string): string {
  return `${statePath}${MARKER_SUFFIX}`;
}

/** True only when the marker is known not to exist. Any other answer, an unreadable directory included, is false. */
export function markerAbsent(statePath: string): boolean {
  try {
    statSync(markerPathOf(statePath));
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT';
  }
}

/** Throws on any failure; the caller decides what an unwritten marker means for it. */
export function writeMarker(statePath: string): void {
  writeFileAtomic(markerPathOf(statePath), 'initialised\n');
}
