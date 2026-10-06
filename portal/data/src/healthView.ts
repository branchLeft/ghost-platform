import type { HealthView } from './reading.js';
import type { healthReading } from './schema.js';

type Row = typeof healthReading.$inferSelect;

/** A stored row as the portals show it. */
export function deriveHealthView(row: Row): HealthView {
  return {
    health: row.health as HealthView['health'],
    reportedVersion: row.reportedVersion,
    versionMatch: row.versionMatch,
    mismatchSince: row.mismatchSince,
    observedAt: row.observedAt,
  };
}
