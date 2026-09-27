import { FORWARDED_PROTO_HEADERS } from './ghostProbe.js';

export interface GhostVersionProbe {
  getVersion(): Promise<string | null>;
}

/**
 * Ghost's admin "site" endpoint answers with no authentication at all
 * and includes the running instance's own version --
 * `{"site":{"version":"6.55.0", ...}}`. That is the whole point of probing
 * it rather than reading a version out of the descriptor: LLD-4's mark is
 * load-bearing that the reported version comes from the instance, never
 * from our own records.
 *
 * Same never-rejects contract as `GhostProbe`: a non-200 status, a
 * malformed body and a connection failure are all folded into the same
 * `null`, because the one caller (this service's `/metrics` route) has
 * nothing useful to do with a distinction between "Ghost said no" and
 * "Ghost didn't say".
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
