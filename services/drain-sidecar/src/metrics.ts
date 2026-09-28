import type { VersionState } from './versionState.js';

/**
 * Hand-rolled Prometheus text exposition, matching the shape
 * `mailgun-shim/src/metrics.ts` already established for this estate: a
 * couple of gauges don't earn a client-library dependency.
 *
 * The scrape is the transport this reading uses to reach `ops1` (LLD-8
 * §09's open question) -- Prometheus already scrapes this estate, so a
 * second, per-tenant `/metrics` endpoint on an existing sidecar process
 * is the same transport again, not a third one. It is also not a held
 * connection, so it carries no producer-side age metric of its own
 * (§03b's rule binds held connections; a scrape is the estate pulling a
 * fresh reading each time, never something that can go silently stale
 * between polls the way a held socket can).
 */
export function renderMetrics(drained: boolean, versionState: VersionState): string {
  const lines = [
    "# HELP drain_sidecar_drained Whether this colour's drain flag is set (1) or clear (0).",
    '# TYPE drain_sidecar_drained gauge',
    `drain_sidecar_drained ${drained ? 1 : 0}`,
  ];

  if (versionState.reported !== null) {
    lines.push(
      "# HELP drain_sidecar_ghost_version_info Ghost's own reported version for this colour. Present only for the undrained colour -- see LLD-8 §09.",
      '# TYPE drain_sidecar_ghost_version_info gauge',
      `drain_sidecar_ghost_version_info{version="${versionState.reported}"} 1`
    );
  }

  if (versionState.matches !== null) {
    lines.push(
      "# HELP drain_sidecar_version_match Whether this colour's reported version matches the descriptor's intended version. Present only for the undrained colour -- a mismatch on the drained one is the definition of the version being retired, not a stuck tenant.",
      '# TYPE drain_sidecar_version_match gauge',
      `drain_sidecar_version_match ${versionState.matches ? 1 : 0}`
    );
  }

  return lines.join('\n') + '\n';
}
