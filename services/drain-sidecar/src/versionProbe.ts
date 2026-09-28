import { FORWARDED_PROTO_HEADERS } from './ghostProbe.js';

export interface GhostVersionProbe {
  getVersion(): Promise<string | null>;
}

/**
 * Reads Ghost's own reported version, never a value from this platform's
 * records. Same never-rejects contract as `GhostProbe`.
 * See ../README.md#reading-ghosts-own-version.
 */
export function createHttpGhostVersionProbe(url: string, timeoutMs: number): GhostVersionProbe {
  return {
    async getVersion() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: FORWARDED_PROTO_HEADERS,
          redirect: 'manual',
        });
        if (response.status !== 200) {
          response.body?.cancel().catch(() => undefined);
          return null;
        }
        const body: unknown = await response.json();
        const version = (body as { site?: { version?: unknown } })?.site?.version;
        return typeof version === 'string' && version.length > 0 ? version : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
