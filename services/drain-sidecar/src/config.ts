export interface SidecarConfig {
  port: number;
  drainFlagPath: string;
  ghostHealthUrl: string;
  ghostProbeTimeoutMs: number;
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

  return {
    port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8080,
    drainFlagPath: requireEnv(env, 'DRAIN_FLAG_PATH'),
    ghostHealthUrl: env.GHOST_HEALTH_URL || 'http://127.0.0.1:2368/',
    ghostProbeTimeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 2000,
  };
}
