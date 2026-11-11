import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import type { StateWitness } from './stateWitness.js';

/**
 * A state file that is missing is a first run only if it was never written.
 * The marker is a small file beside it, written once after the first
 * successful save: a missing file with the marker present has vanished (an
 * unmounted or wiped volume, a deleted file) and is not a first run. A marker
 * that cannot be told apart from present counts as present, so doubt reads as
 * a loss, never as a clean start. With a witness on another mount, a missing
 * file with the witness present has had its whole volume replaced. See
 * ../README.md#state-markers and ../README.md#state-witness.
 */

const MARKER_SUFFIX = '.initialised';
const PLAIN_BODY = 'initialised\n';
// Says a witness was written first, so a witness later missing is a loss and not an upgrade.
const WITNESSED_BODY = 'initialised witnessed\n';

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

function readMarker(statePath: string): 'absent' | 'plain' | 'witnessed' | 'unknown' {
  try {
    return readFileSync(markerPathOf(statePath), 'utf8') === PLAIN_BODY ? 'plain' : 'witnessed';
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/**
 * What a missing state file means. `first-run` only when no marker and no
 * witness were ever written; `vanished` when the marker is there (or cannot be
 * told apart from there); `volume-replaced` when the marker is gone but the
 * witness on the other mount remembers the file.
 */
export function missingFileVerdict(
  statePath: string,
  witness?: StateWitness
): 'first-run' | 'vanished' | 'volume-replaced' {
  if (!markerAbsent(statePath)) {
    return 'vanished';
  }
  if (witness !== undefined && witness.probe(statePath) !== 'absent') {
    return 'volume-replaced';
  }
  return 'first-run';
}

/**
 * What a state file that is there can be trusted for. `unmarked`: written by a
 * build before the marker or the witness existed, so the missing parts are
 * written now. `witness-lost`: a marker that promises a witness, and none to
 * be found (the witness removed, replaced, or no longer configured).
 */
export function presentFileTrust(
  statePath: string,
  witness?: StateWitness
): 'trusted' | 'unmarked' | 'witness-lost' {
  const marker = readMarker(statePath);
  if (marker === 'absent') {
    return 'unmarked';
  }
  if (witness === undefined) {
    return marker === 'witnessed' ? 'witness-lost' : 'trusted';
  }
  if (marker === 'plain') {
    return 'unmarked';
  }
  return witness.probe(statePath) === 'present' ? 'trusted' : 'witness-lost';
}

/**
 * Throws on any failure; the caller decides what an unwritten marker means for it.
 * The witness goes first and the marker last, so a marker that promises a
 * witness never exists without one.
 */
export function writeMarker(statePath: string, witness?: StateWitness): void {
  witness?.write(statePath);
  writeFileAtomic(markerPathOf(statePath), witness === undefined ? PLAIN_BODY : WITNESSED_BODY);
}
