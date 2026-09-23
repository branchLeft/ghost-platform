import { readFileSync } from 'node:fs';
import type { BlockList } from 'node:net';
import { MIN_KEY_BYTES } from './cookie.js';
import { parseTrustedProxies } from './source.js';

export interface GateConfig {
  readonly port: number;
  readonly host: string;
  readonly slotsPath: string;
  readonly leaseDir: string;
  readonly signingKey: Buffer;
  readonly trustedProxies: BlockList;
  readonly cookieTtlSeconds: number;
  readonly ceilingLimit: number;
  readonly ceilingWindowMs: number;
  readonly ceilingMaxSources: number;
  readonly ceilingBroadLimit: number;
  readonly ceilingBroadMaxSources: number;
  readonly argon2MaxConcurrent: number;
  readonly argon2MaxQueued: number;
}

export type GateEnv = Record<string, string | undefined>;

function requireEnv(env: GateEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(env: GateEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
  return Number(raw);
}

/**
 * Every input that decides who is admitted has no default: the slots file,
 * the lease directory and the signing key. An unset value refuses to start
 * rather than guessing. The key is read from a file so it never appears in
 * the process environment, and must be at least 32 bytes.
 */
export function loadConfig(
  env: GateEnv,
  readKey: (path: string) => Buffer = (path) => readFileSync(path)
): GateConfig {
  const signingKey = readKey(requireEnv(env, 'GATE_SIGNING_KEY_FILE'));
  if (signingKey.length < MIN_KEY_BYTES) {
    throw new Error(`GATE_SIGNING_KEY_FILE must hold at least ${MIN_KEY_BYTES} bytes`);
  }
  return {
    port: positiveInteger(env, 'PORT', 8080, 65535),
    host: env.LISTEN_HOST || '127.0.0.1',
    slotsPath: requireEnv(env, 'GATE_SLOTS_FILE'),
    leaseDir: requireEnv(env, 'GATE_LEASE_DIR'),
    signingKey,
    trustedProxies: parseTrustedProxies(env.GATE_TRUSTED_PROXIES ?? ''),
    cookieTtlSeconds: positiveInteger(env, 'GATE_COOKIE_TTL_SECONDS', 12 * 3600, 7 * 24 * 3600),
    ceilingLimit: positiveInteger(env, 'GATE_CEILING_ATTEMPTS', 10, 1000),
    ceilingWindowMs: positiveInteger(env, 'GATE_CEILING_WINDOW_SECONDS', 900, 86400) * 1000,
    ceilingMaxSources: positiveInteger(env, 'GATE_CEILING_MAX_SOURCES', 100_000, 10_000_000),
    // A second, coarser ceiling over the same window: one bucket per IPv6
    // /48 rather than /64, so a flood spread across many /64s inside a
    // single /48 (a block routinely allocated whole to one customer) still
    // exhausts a bucket instead of multiplying past the per-/64 limit
    // uncounted. Limit and table size are both larger than the narrow
    // ceiling's own -- a /48 aggregates many genuine visitors' /64s too,
    // and this tier exists to catch a flood, not to throttle ordinary
    // traffic sharing an allocation.
    ceilingBroadLimit: positiveInteger(env, 'GATE_CEILING_BROAD_ATTEMPTS', 200, 20_000),
    ceilingBroadMaxSources: positiveInteger(
      env,
      'GATE_CEILING_BROAD_MAX_SOURCES',
      20_000,
      2_000_000
    ),
    // Bounded at 3, one below Node's default libuv threadpool size (4):
    // `crypto.argon2` and `fs` share that pool, and `verify` -- which runs
    // on every forward_auth, every page and every asset -- does several
    // `fs` calls of its own (the slots read; open/read/close on the lease
    // record). Measured on this machine: with the cap at 4, saturating it
    // pushed `verify`'s own file operations from a 0.13 ms idle median to a
    // 112 ms median (130 ms max) -- the whole pool was busy deriving. At 3,
    // one thread stays free for `fs` work and the same measurement holds at
    // a 0.3 ms median (1.8 ms max). The fix is the cap sitting *below* the
    // pool, not above or equal to it; raising `UV_THREADPOOL_SIZE` instead
    // would also work but adds a second place to keep in sync, so this
    // config does not do that. 64 concurrent waiters is the queue's own
    // cap, so a flood is refused once it would hold more pending
    // derivations than that.
    argon2MaxConcurrent: positiveInteger(env, 'GATE_ARGON2_MAX_CONCURRENT', 3, 64),
    argon2MaxQueued: positiveInteger(env, 'GATE_ARGON2_MAX_QUEUED', 64, 10_000),
  };
}
