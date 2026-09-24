import { isSyntacticallyValidHostname } from './hostname.js';

export interface AskConfig {
  readonly port: number;
  /**
   * The interface this process binds to. No default: an unset value would
   * leave the process free to fall back to every interface, which is
   * exactly the failure this config exists to make impossible to reach by
   * accident (LLD-5 E2 -- "the ask endpoint is therefore only as safe as
   * its network position"). A wildcard value (`0.0.0.0`, `::`, `[::]`) is
   * refused for the same reason: it is not an unset value, but it produces
   * the identical failure -- reachable from every interface -- so refusing
   * it here is the load-bearing half of the story's own done-means control
   * case: "bind it to all interfaces and the reachability test goes red".
   */
  readonly bindHost: string;
  /** Directory of one JSON tenant descriptor per file, refreshed on a timer. */
  readonly descriptorDir: string;
  /**
   * The zone a paying tenant's `ours` hostname renders under --
   * render-core's `ZoneConfig.platformZone`, expanded with a descriptor's
   * `sub` by render-core's own `servedHostnameOf` (descriptorStore.ts).
   */
  readonly platformZone: string;
  /**
   * Every registrable domain the estate owns, so a `theirs` fqdn that is
   * itself one of them (or a subdomain of one) is refused rather than
   * admitted -- a "custom domain" is only a custom domain if it is
   * genuinely outside every domain the platform owns (render-core's
   * `ZoneConfig.ownedDomains`, same reasoning).
   */
  readonly ownedDomains: readonly string[];
  readonly refreshIntervalMs: number;
  /**
   * How long the served set may go on answering from a directory read that
   * last succeeded this long ago. A directory outage should not mean every
   * hostname stays served forever -- past this bound the store fails
   * closed (descriptorStore.ts's `has()`), the same direction as an
   * unreadable directory at boot.
   */
  readonly descriptorMaxStalenessMs: number;
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

// Every spelling of "every interface" this service is ever likely to be
// handed: the IPv4 unspecified address, and IPv6's in both its compressed
// and bracketed forms. Compared case-insensitively and after stripping
// brackets, rather than parsed as a real IP address -- the failure mode
// this guards is a copy-pasted `0.0.0.0` from another service's config or
// example, not a deliberately obscure encoding of it.
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);

function isWildcardBindHost(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return WILDCARD_BIND_HOSTS.has(normalized);
}

function requireHostname(env: AskEnv, name: string): string {
  const value = requireEnv(env, name);
  if (!isSyntacticallyValidHostname(value)) {
    throw new Error(`${name} "${value}" is not a well-formed hostname`);
  }
  return value;
}

export function loadConfig(env: AskEnv = process.env): AskConfig {
  const bindHost = requireEnv(env, 'BIND_HOST');
  if (isWildcardBindHost(bindHost)) {
    throw new Error(
      `BIND_HOST "${bindHost}" binds every interface, which defeats the only defence this ` +
        "service has (LLD-5 E2) -- set it to the edge's own private interface address."
    );
  }
  const ownedDomains = requireEnv(env, 'OWNED_DOMAINS')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
  if (ownedDomains.length === 0) {
    throw new Error('OWNED_DOMAINS must name at least one domain');
  }
  for (const domain of ownedDomains) {
    if (!isSyntacticallyValidHostname(domain)) {
      throw new Error(`OWNED_DOMAINS entry "${domain}" is not a well-formed hostname`);
    }
  }

  return {
    port: positiveIntOr(env.PORT, 9000),
    bindHost,
    descriptorDir: requireEnv(env, 'DESCRIPTOR_DIR'),
    platformZone: requireHostname(env, 'BASE_DOMAIN'),
    ownedDomains,
    refreshIntervalMs: positiveIntOr(env.REFRESH_INTERVAL_MS, 5000),
    descriptorMaxStalenessMs: positiveIntOr(env.DESCRIPTOR_MAX_STALENESS_MS, 60_000),
    rateLimitCapacity: positiveIntOr(env.RATE_LIMIT_CAPACITY, 50),
    rateLimitRefillPerSecond: positiveIntOr(env.RATE_LIMIT_REFILL_PER_SECOND, 10),
  };
}
