import type { VersionState } from './versionState.js';

/**
 * Hand-rolled Prometheus text exposition, matching the shape
 * `mailgun-shim/src/metrics.ts` already established for this estate.
 * See ../README.md#get-metrics--per-tenant-health-and-version.
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
