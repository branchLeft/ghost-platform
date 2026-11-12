import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * A witness is a small file per state file, kept on a different mount from the
 * state it vouches for. A state volume replaced by an empty one takes the
 * marker with it but not the witness, so the two then disagree. See
 * ../README.md#state-witness.
 */
export interface StateWitness {
  /** `present` only when the witness is known to exist; any other answer, an unreadable directory included, is `unknown`. */
  probe(statePath: string): 'present' | 'absent' | 'unknown';
  /** Throws on any failure; the caller decides what an unwritten witness means for it. */
  write(statePath: string): void;
}

export interface StateWitnessOptions {
  /** Directory the witness files live in. Must be on a different mount from every state file's directory. */
  dir: string;
  /** Every state file the witness will vouch for. */
  statePaths: readonly string[];
  /** Injectable so a test can stand in for two mounts. */
  mountKeyOf?: (path: string) => string;
}

/** The mount holding `realPath`: the id of the longest mount point that is a prefix of it, the last listed on a tie. */
export function mountIdFromInfo(mountinfo: string, realPath: string): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const id = fields[0];
    const rawPoint = fields[4];
    if (!id || !rawPoint) {
      continue;
    }
    const point = rawPoint.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8))
    );
    const inside = point === '/' || realPath === point || realPath.startsWith(`${point}/`);
    if (inside && (best === undefined || point.length >= best.length)) {
      best = { id, length: point.length };
    }
  }
  return best?.id;
}

/**
 * Two docker volumes on one host disk share a device number, so the device
 * alone would refuse a good layout. The mount id tells bind mounts apart; where
 * the mount table cannot be read the device number is the fallback, which can
 * only refuse too much, never too little.
 */
export function defaultMountKey(path: string): string {
  const real = realpathSync(path);
  try {
    const id = mountIdFromInfo(readFileSync('/proc/self/mountinfo', 'utf8'), real);
    if (id !== undefined) {
      return `mount:${id}`;
    }
  } catch {
    // Not Linux, or not readable: fall through to the device.
  }
  return `dev:${statSync(real).dev}`;
}

function witnessFileOf(dir: string, statePath: string): string {
  const digest = createHash('sha256').update(resolve(statePath)).digest('hex').slice(0, 12);
  return join(dir, `${basename(statePath)}.${digest}.witness`);
}

/** Throws when the witness directory shares a mount with any state file's directory: a witness there would be replaced with the state. */
export function createStateWitness(options: StateWitnessOptions): StateWitness {
  const { dir, statePaths } = options;
  const mountKeyOf = options.mountKeyOf ?? defaultMountKey;
  mkdirSync(dir, { recursive: true });
  const witnessKey = mountKeyOf(dir);
  for (const statePath of statePaths) {
    mkdirSync(dirname(statePath), { recursive: true });
    if (mountKeyOf(dirname(statePath)) === witnessKey) {
      throw new Error(
        `COLLECTOR_STATE_WITNESS_DIR must be on a different mount from ${dirname(statePath)}`
      );
    }
  }
  return {
    probe(statePath: string): 'present' | 'absent' | 'unknown' {
      try {
        statSync(witnessFileOf(dir, statePath));
        return 'present';
      } catch (error) {
        return (error as { code?: unknown }).code === 'ENOENT' ? 'absent' : 'unknown';
      }
    },
    write(statePath: string): void {
      writeFileAtomic(witnessFileOf(dir, statePath), 'witnessed\n');
    },
  };
}
