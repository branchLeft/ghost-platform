export interface SidecarConfig {
  port: number;
  /**
   * When set, the service listens on this unix socket and never opens a TCP
   * port. See ../README.md#listening-on-a-unix-socket.
   */
  socketPath: string | null;
  drainFlagPath: string;
  ghostHealthUrl: string;
  ghostProbeTimeoutMs: number;
  ghostAdminSiteUrl: string;
  /**
   * The Ghost version the descriptor intends, or `null` when nothing has
   * told this process yet. See ../README.md#get-metrics--per-tenant-health-and-version.
   */
  intendedGhostVersion: string | null;
  /**
   * Exit non-zero once nothing has answered on Ghost's address for this long,
   * so a restart policy re-joins Ghost's current network namespace. `null`
   * (unset or not a positive number) never exits. See
   * ../README.md#a-ghost-that-restarts-under-it.
   */
  exitAfterGhostUnreachableMs: number | null;
}

// Structurally identical to NodeJS.ProcessEnv, spelled out instead of named
// so this file has no dependency on the ambient @types/node globals eslint's
// plain (non-type-aware) config doesn't resolve.
export type SidecarEnv = Record<string, string | undefined>;

function requireEnv(env: SidecarEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * DRAIN_FLAG_PATH has no default. An unset value would leave the sidecar
 * with nothing to check and no honest way to fail closed, so it refuses to
 * start rather than silently answering 200 regardless of drain state.
 */
export function loadConfig(env: SidecarEnv = process.env): SidecarConfig {
  const portRaw = Number(env.PORT);
  const timeoutRaw = Number(env.GHOST_PROBE_TIMEOUT_MS);
  const ghostHealthUrl = env.GHOST_HEALTH_URL || 'http://127.0.0.1:2368/';
  const intendedGhostVersion = env.GHOST_INTENDED_VERSION?.trim() || null;
  const exitAfterRaw = Number(env.EXIT_AFTER_GHOST_UNREACHABLE_MS);

  return {
    port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8080,
    socketPath: env.SOCKET_PATH?.trim() || null,
    drainFlagPath: requireEnv(env, 'DRAIN_FLAG_PATH'),
    ghostHealthUrl,
    ghostProbeTimeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 2000,
    // Ghost's unauthenticated site endpoint, same origin as the health
    // probe's own URL by default -- both are loopback calls to the same
    // Ghost, per compose.ts's own note that this sidecar shares Ghost's
    // network namespace rather than reaching it any other way.
    ghostAdminSiteUrl:
      env.GHOST_ADMIN_SITE_URL || new URL('/ghost/api/admin/site/', ghostHealthUrl).toString(),
    intendedGhostVersion,
    exitAfterGhostUnreachableMs:
      env.EXIT_AFTER_GHOST_UNREACHABLE_MS && Number.isFinite(exitAfterRaw) && exitAfterRaw > 0
        ? exitAfterRaw
        : null,
  };
}
