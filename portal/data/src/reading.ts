import type { HealthState } from './schema.js';

/** What the ingestion stores, and both portals show, for one tenant. */
export interface Reading {
  readonly health: HealthState;
  /** Ghost's own reported version, from the undrained colour only. */
  readonly reportedVersion: string | null;
  /** Whether the reported version is the descriptor's intended one; null if unknown. */
  readonly versionMatch: boolean | null;
}

export class MalformedScrapeError extends Error {
  constructor(reason: string) {
    super(`unreadable sidecar scrape: ${reason}`);
    this.name = 'MalformedScrapeError';
  }
}

interface Scrape {
  readonly drained: boolean;
  readonly reportedVersion: string | null;
  readonly versionMatch: boolean | null;
}

const DRAINED = /^drain_sidecar_drained ([01])$/;
const VERSION = /^drain_sidecar_ghost_version_info\{version="([0-9A-Za-z.+-]{1,64})"\} 1$/;
const MATCH = /^drain_sidecar_version_match ([01])$/;

/**
 * Reads one colour's `GET /metrics` text (the drain sidecar's Prometheus
 * exposition). A scrape with no drain flag is refused rather than guessed at:
 * which colour answers is the whole question.
 */
export function parseScrape(text: string): Scrape {
  let drained: boolean | null = null;
  let reportedVersion: string | null = null;
  let versionMatch: boolean | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const d = DRAINED.exec(line);
    if (d) {
      drained = d[1] === '1';
      continue;
    }
    const v = VERSION.exec(line);
    if (v) {
      reportedVersion = v[1] ?? null;
      continue;
    }
    const m = MATCH.exec(line);
    if (m) versionMatch = m[1] === '1';
  }
  if (drained === null) throw new MalformedScrapeError('no drain flag');
  return { drained, reportedVersion, versionMatch };
}

/**
 * The reading for one tenant from its colours' scrapes. Only the undrained
 * colour answers: with one undrained colour its version and match are the
 * tenant's, and a drained colour's are never used, so a mismatch during an
 * overlap is not a stuck tenant. With none or more than one undrained
 * colour, or no scrape at all, there is nothing to say, and the reading is
 * unknown.
 */
export function deriveReading(scrapes: readonly string[]): Reading {
  const live = scrapes.map(parseScrape).filter((scrape) => !scrape.drained);
  const only = live.length === 1 ? live[0] : undefined;
  if (only === undefined) {
    return { health: 'unknown', reportedVersion: null, versionMatch: null };
  }
  return {
    health: only.reportedVersion === null ? 'unhealthy' : 'healthy',
    reportedVersion: only.reportedVersion,
    versionMatch: only.versionMatch,
  };
}

/** A stored reading, as shown. */
export interface HealthView extends Reading {
  /** When the current run of mismatching readings began; null when there is none. */
  readonly mismatchSince: Date | null;
  readonly observedAt: Date;
}
