import { escapeHtml } from './html.js';

/** The reading both portals show; the storage layer's own type satisfies it. */
export interface HealthShown {
  readonly health: string;
  readonly reportedVersion: string | null;
  readonly versionMatch: boolean | null;
  readonly mismatchSince: Date | null;
}

/** The values both portals show for one tenant, as already-escaped markup. */
export function renderHealth(health: HealthShown | null): string {
  if (health === null) {
    return '<dl><dt>SITE_HEALTH</dt><dd>NO_READING</dd></dl>';
  }
  const version =
    health.reportedVersion === null ? 'NO_VERSION' : escapeHtml(health.reportedVersion);
  const match =
    health.versionMatch === null
      ? 'MATCH_UNKNOWN'
      : health.versionMatch
        ? 'VERSION_MATCHES'
        : 'VERSION_MISMATCH';
  const since =
    health.mismatchSince === null
      ? ''
      : `<dt>MISMATCH_SINCE</dt><dd><time datetime="${health.mismatchSince.toISOString()}">${health.mismatchSince.toISOString().slice(0, 10)}</time></dd>`;
  return (
    `<dl><dt>SITE_HEALTH</dt><dd>${escapeHtml(health.health.toUpperCase())}</dd>` +
    `<dt>GHOST_VERSION</dt><dd>${version}</dd>` +
    `<dt>VERSION_CHECK</dt><dd>${match}</dd>${since}</dl>`
  );
}
