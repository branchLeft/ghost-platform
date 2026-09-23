export interface AskConfig {
  readonly port: number;
  /**
   * The interface this process binds to. No default: an unset value would
   * leave the process free to fall back to every interface, which is
   * exactly the failure this config exists to make impossible to reach by
   * accident (LLD-5 E2 -- "the ask endpoint is therefore only as safe as
   * its network position").
   */
  readonly bindHost: string;
  /** Directory of one JSON tenant descriptor per file, refreshed on a timer. */
  readonly descriptorDir: string;
  /**
   * The platform's own base domain, used to expand a `hostname.kind ===
   * "ours"` descriptor's `sub` into the fully-qualified name Caddy asks
   * about. Not part of the descriptor itself -- see render-core's
   * `HostnameSpec` -- because it is a property of this edge's deployment,
   * not of any one tenant.
   */
  readonly baseDomain: string;
  readonly refreshIntervalMs: number;
  /** The fixed-size token bucket applied to every miss (LLD-5 E3). */
  readonly rateLimitCapacity: number;
  readonly rateLimitRefillPerSecond: number;
}

// Structurally identical to NodeJS.ProcessEnv, spelled out instead of named
// so this file has no dependency on the ambient @types/node globals eslint's
// plain (non-type-aware) config doesn't resolve.
export type AskEnv = Record<string, string | undefined>;

function requireEnv(env: AskEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(env: AskEnv = process.env): AskConfig {
  return {
    port: positiveIntOr(env.PORT, 9000),
    bindHost: requireEnv(env, 'BIND_HOST'),
    descriptorDir: requireEnv(env, 'DESCRIPTOR_DIR'),
    baseDomain: requireEnv(env, 'BASE_DOMAIN'),
    refreshIntervalMs: positiveIntOr(env.REFRESH_INTERVAL_MS, 5000),
    rateLimitCapacity: positiveIntOr(env.RATE_LIMIT_CAPACITY, 50),
    rateLimitRefillPerSecond: positiveIntOr(env.RATE_LIMIT_REFILL_PER_SECOND, 10),
  };
}
