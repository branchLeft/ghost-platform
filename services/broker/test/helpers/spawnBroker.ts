import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `config.ts`'s `PORT` validation refuses `0` (its whole-number regex
 * starts at 1), so a spawned process cannot be told "pick any free port"
 * the way an in-process `server.listen(0, ...)` can. Binding a throwaway
 * server to port 0, reading what the OS gave it and closing it immediately
 * is the standard practical stand-in -- a narrow race (another process
 * grabbing the same port before the spawn) that is acceptable in a test.
 */
export async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_DIR = join(SERVICE_ROOT, 'src');
const DIST_SERVER = join(SERVICE_ROOT, 'dist', 'server.js');
const TSC = join(SERVICE_ROOT, 'node_modules', '.bin', 'tsc');

/**
 * The newest mtime under `src/`, recursively. Compared against
 * `dist/server.js`'s own mtime, this is what "stale" means below: a `.ts`
 * edited after the last build produced JS the edit never reached.
 */
function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(path));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/**
 * This suite has to run against the actual built entrypoint
 * (`dist/server.js`), not against `src/server.ts` imported in-process --
 * an in-process import proves the wiring function, never that
 * `node dist/server.js` (what a real deploy runs) behaves the same way.
 * Rebuilds whenever `dist/server.js` is missing *or* older than the newest
 * file under `src/`, not merely missing, so a stale build never reports a
 * regression green. See spawnBroker.md#ensurebuilt.
 */
export function ensureBuilt(): void {
  if (existsSync(DIST_SERVER) && statSync(DIST_SERVER).mtimeMs >= newestSourceMtimeMs(SRC_DIR)) {
    return;
  }
  try {
    execFileSync(TSC, ['-p', 'tsconfig.build.json'], { cwd: SERVICE_ROOT, stdio: 'pipe' });
  } catch (err) {
    // `tsc` still emits JS on a type error (this project sets no
    // `noEmitOnError`) -- what actually matters to a process-boundary test
    // is whether runnable output exists, not whether the compiler was
    // happy. A deliberate sabotage that removes a type guard can produce
    // exactly this shape (valid JS, a type error at the now-unchecked
    // narrowing site), and the whole point is to run that JS and watch it
    // misbehave, not to have the build step swallow the finding first.
    if (!existsSync(DIST_SERVER)) throw err;
  }
}

export interface SpawnedBroker {
  readonly proc: ChildProcess;
  waitListening(timeoutMs?: number): Promise<{ port: number }>;
  waitExit(timeoutMs?: number): Promise<number | null>;
  output(): string;
  stop(): void;
}

/** How many times `waitListening` spawns the broker before it gives up. */
export const MAX_BIND_ATTEMPTS = 3;

export interface SpawnBrokerOptions {
  /**
   * Chooses the port a retry binds to after the broker exits with
   * EADDRINUSE. Defaults to `findFreePort`; a test injects its own to make
   * the collision deterministic.
   */
  pickPort?: () => Promise<number>;
}

interface Attempt {
  proc: ChildProcess;
  combined: string;
}

/**
 * Spawns `dist/server.js`. A caller's `PORT` can be taken between the probe
 * in `findFreePort` and the broker's own `listen` (a parallel test grabs it
 * in that gap), so when the broker exits with EADDRINUSE before listening,
 * `waitListening` picks a new port and respawns it. At most
 * MAX_BIND_ATTEMPTS spawns; after that it throws, naming every port tried.
 */
export function spawnBroker(
  env: Record<string, string | undefined>,
  options: SpawnBrokerOptions = {}
): SpawnedBroker {
  ensureBuilt();
  const pickPort = options.pickPort ?? findFreePort;

  function launch(childEnv: Record<string, string | undefined>): Attempt {
    const proc = spawn(process.execPath, [DIST_SERVER], {
      env: { ...process.env, ...childEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const attempt: Attempt = { proc, combined: '' };
    proc.stdout?.on('data', (d: Buffer) => {
      attempt.combined += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      attempt.combined += d.toString();
    });
    return attempt;
  }

  let childEnv: Record<string, string | undefined> = env;
  const portsTried: string[] = [String(env.PORT)];
  let current = launch(childEnv);

  async function poll(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out ${label}. Output so far:\n${current.combined}`);
  }

  return {
    get proc() {
      return current.proc;
    },
    async waitListening(timeoutMs = 8000) {
      for (;;) {
        const attempt = current;
        await poll(
          () =>
            /broker listening on [^:]+:(\d+)/.test(attempt.combined) ||
            attempt.proc.exitCode !== null,
          timeoutMs,
          'waiting for the broker to report listening'
        );
        if (attempt.proc.exitCode === null) {
          const match = /broker listening on [^:]+:(\d+)/.exec(attempt.combined);
          if (!match?.[1]) throw new Error(`no listen line found. Output:\n${attempt.combined}`);
          return { port: Number(match[1]) };
        }
        if (!attempt.combined.includes('EADDRINUSE')) {
          throw new Error(
            `process exited (code ${attempt.proc.exitCode}) before listening. Output:\n${attempt.combined}`
          );
        }
        if (portsTried.length >= MAX_BIND_ATTEMPTS) {
          throw new Error(
            `broker could not bind a free port in ${MAX_BIND_ATTEMPTS} attempts ` +
              `(EADDRINUSE on ports ${portsTried.join(', ')}). Output:\n${attempt.combined}`
          );
        }
        childEnv = { ...childEnv, PORT: String(await pickPort()) };
        portsTried.push(String(childEnv.PORT));
        current = launch(childEnv);
      }
    },
    async waitExit(timeoutMs = 8000) {
      await poll(
        () => current.proc.exitCode !== null,
        timeoutMs,
        'waiting for the process to exit'
      );
      return current.proc.exitCode;
    },
    output: () => current.combined,
    stop: () => {
      current.proc.kill('SIGKILL');
    },
  };
}
