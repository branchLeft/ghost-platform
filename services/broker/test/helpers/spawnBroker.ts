import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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
const DIST_SERVER = join(SERVICE_ROOT, 'dist', 'server.js');
const TSC = join(SERVICE_ROOT, 'node_modules', '.bin', 'tsc');

/**
 * The F5 proof this whole file exists for has to run against the actual
 * built entrypoint (`dist/server.js`), not against `src/server.ts` imported
 * in-process -- an in-process import proves the wiring function, never that
 * `node dist/server.js` (what a real deploy runs) behaves the same way.
 * Builds once per test run if `dist/` is stale or missing; `npm run
 * coverage` alone (no separate build step) still works this way, and
 * `broker-ci.yml`'s explicit build step just means this is a no-op there.
 */
export function ensureBuilt(): void {
  if (existsSync(DIST_SERVER)) return;
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

export function spawnBroker(env: Record<string, string | undefined>): SpawnedBroker {
  ensureBuilt();
  const proc = spawn(process.execPath, [DIST_SERVER], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let combined = '';
  proc.stdout?.on('data', (d: Buffer) => {
    combined += d.toString();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    combined += d.toString();
  });

  async function poll(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out ${label}. Output so far:\n${combined}`);
  }

  return {
    proc,
    async waitListening(timeoutMs = 8000) {
      await poll(
        () => /broker listening on [^:]+:(\d+)/.test(combined) || proc.exitCode !== null,
        timeoutMs,
        'waiting for the broker to report listening'
      );
      if (proc.exitCode !== null) {
        throw new Error(
          `process exited (code ${proc.exitCode}) before listening. Output:\n${combined}`
        );
      }
      const match = /broker listening on [^:]+:(\d+)/.exec(combined);
      if (!match?.[1]) throw new Error(`no listen line found. Output:\n${combined}`);
      return { port: Number(match[1]) };
    },
    async waitExit(timeoutMs = 8000) {
      await poll(() => proc.exitCode !== null, timeoutMs, 'waiting for the process to exit');
      return proc.exitCode;
    },
    output: () => combined,
    stop: () => {
      proc.kill('SIGKILL');
    },
  };
}
