import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const REPLAY_TTL_SECONDS = 3 * 60 * 60;
/**
 * Two keys per accepted complaint, so this must stay at or above twice the
 * most records the 5 MiB queue can hold: the queue cap binds first.
 */
export const REPLAY_MAX_ENTRIES = 200_000;

export class ReplayFullError extends Error {
  constructor() {
    super('replay set is at its hard cap');
  }
}

export interface ReplayStore {
  has(key: string): boolean;
  /** Throws ReplayFullError when `keys` would not fit; writes nothing. */
  assertRoom(keys: readonly string[]): void;
  /** Persists every key before returning; throws ReplayFullError at the cap. */
  add(keys: readonly string[]): void;
  size(): number;
  close(): void;
}

interface Entry {
  k: string;
  exp: number;
}

/**
 * Seen-set of webhook ids and event ids, each kept for the TTL and persisted
 * so a restart does not reopen the replay window. Expired entries are dropped
 * on read; the file is rewritten at open and when it has grown to twice the
 * live set.
 */
export function openReplayStore(
  dir: string,
  now: () => number,
  options: { ttlSeconds?: number; maxEntries?: number } = {}
): ReplayStore {
  const ttl = options.ttlSeconds ?? REPLAY_TTL_SECONDS;
  const maxEntries = options.maxEntries ?? REPLAY_MAX_ENTRIES;
  const path = join(dir, 'replay.ndjson');
  const live = new Map<string, number>();
  let fileLines = 0;

  const nowSeconds = (): number => Math.floor(now() / 1000);

  function prune(): void {
    const t = nowSeconds();
    for (const [k, exp] of live) {
      if (exp <= t) {
        live.delete(k);
      }
    }
  }

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    const lastNewline = text.lastIndexOf('\n');
    // A crash mid-append can leave a final line with no newline: ignore it.
    const complete = text.slice(0, lastNewline + 1);
    for (const line of complete.split('\n')) {
      if (line.length > 0) {
        const entry = JSON.parse(line) as Entry;
        live.set(entry.k, entry.exp);
      }
    }
  }
  prune();

  function rewrite(fdToClose?: number): number {
    const tmp = `${path}.tmp`;
    const text = [...live].map(([k, exp]) => JSON.stringify({ k, exp }) + '\n').join('');
    writeFileSync(tmp, text, { mode: 0o600 });
    const tmpFd = openSync(tmp, 'r');
    fsyncSync(tmpFd);
    closeSync(tmpFd);
    if (fdToClose !== undefined) {
      closeSync(fdToClose);
    }
    renameSync(tmp, path);
    fileLines = live.size;
    return openSync(path, 'a');
  }

  let fd = rewrite();

  return {
    has(key) {
      const exp = live.get(key);
      return exp !== undefined && exp > nowSeconds();
    },
    assertRoom(keys) {
      prune();
      if (live.size + keys.filter((k) => !live.has(k)).length > maxEntries) {
        throw new ReplayFullError();
      }
    },
    add(keys) {
      this.assertRoom(keys);
      const fresh = keys.filter((k) => !live.has(k));
      const exp = nowSeconds() + ttl;
      for (const k of fresh) {
        writeSync(fd, JSON.stringify({ k, exp }) + '\n');
        live.set(k, exp);
        fileLines += 1;
      }
      fsyncSync(fd);
      if (fileLines > 2 * live.size + 100) {
        fd = rewrite(fd);
      }
    },
    size() {
      return live.size;
    },
    close() {
      closeSync(fd);
    },
  };
}
