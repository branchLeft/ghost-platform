import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { servedHostnameOf, type TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { isSyntacticallyValidHostname } from './hostname.js';

export interface DescriptorStoreOptions {
  readonly descriptorDir: string;
  readonly platformZone: string;
  readonly ownedDomains: readonly string[];
  /** See `AskConfig.descriptorMaxStalenessMs`. */
  readonly maxStalenessMs: number;
  /** Defaults to `console.warn`; overridable so tests can capture it. */
  readonly onSkippedFile?: (file: string, reason: string) => void;
  /** Defaults to `Date.now`; overridable so tests can control staleness. */
  readonly now?: () => number;
}

/**
 * A minimal, local shape check -- not render-core's `validate()`, which
 * duplicates a gate already run upstream (LLD-5 §07). Just enough shape
 * for `servedHostnameOf` to read `kind`/`hostname` safely.
 * See ../README.md#descriptorstore-hasvalidshapeforserving.
 */
function hasValidShapeForServing(
  value: unknown
): value is Pick<TenantDescriptor, 'kind' | 'hostname'> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'demo' && kind !== 'tenant') {
    return false;
  }
  if (!('hostname' in value)) {
    return false;
  }
  const hostname = (value as { hostname: unknown }).hostname;
  if (typeof hostname !== 'object' || hostname === null || !('kind' in hostname)) {
    return false;
  }
  const hostnameKind = (hostname as { kind: unknown }).kind;
  if (hostnameKind === 'ours') {
    const sub = (hostname as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0;
  }
  if (hostnameKind === 'theirs') {
    const fqdn = (hostname as { fqdn?: unknown }).fqdn;
    return typeof fqdn === 'string' && fqdn.length > 0;
  }
  return false;
}

/**
 * The in-memory served-hostname set an ask asks against. A negative
 * answer costs no read of anything (LLD-5 E3). Which hostname a
 * descriptor derives to is render-core's `servedHostnameOf`, not a copy.
 * See ../README.md#descriptorstore-descriptorstore.
 */
export class DescriptorStore {
  private served: ReadonlySet<string> = new Set();
  private readonly descriptorDir: string;
  private readonly zones: { platformZone: string; ownedDomains: readonly string[] };
  private readonly maxStalenessMs: number;
  private readonly onSkippedFile: (file: string, reason: string) => void;
  private readonly now: () => number;
  private lastGoodRefreshAtMs: number | null = null;
  // Guards against two refreshes racing: the timer in server.ts fires on a
  // fixed interval regardless of how long the previous read took, and an
  // overlapping pair finishing out of order could install a stale set over
  // a fresher one. A single in-flight promise both callers join makes a
  // "refresh while refreshing" a no-op rather than a race.
  private inFlight: Promise<void> | null = null;

  constructor(options: DescriptorStoreOptions) {
    this.descriptorDir = options.descriptorDir;
    this.zones = { platformZone: options.platformZone, ownedDomains: options.ownedDomains };
    this.maxStalenessMs = options.maxStalenessMs;
    this.now = options.now ?? Date.now;
    this.onSkippedFile =
      options.onSkippedFile ??
      ((file, reason) => console.warn(`odask: skipping ${file}: ${reason}`));
  }

  /**
   * Fails closed once the last successful directory read is further in the
   * past than `maxStalenessMs` allows -- including at boot, before any
   * refresh has ever succeeded. A directory outage must not mean every
   * hostname stays served forever; it must eventually mean none does.
   */
  has(hostname: string): boolean {
    if (this.lastGoodRefreshAtMs === null) {
      return false;
    }
    if (this.now() - this.lastGoodRefreshAtMs > this.maxStalenessMs) {
      return false;
    }
    return this.served.has(hostname);
  }

  get size(): number {
    return this.served.size;
  }

  /** Whether the served set is currently too stale to answer from (see `has()`). */
  get isStale(): boolean {
    return (
      this.lastGoodRefreshAtMs === null ||
      this.now() - this.lastGoodRefreshAtMs > this.maxStalenessMs
    );
  }

  /**
   * Rebuilds the served set atomically from a caller's point of view; a
   * per-file parse/shape failure excludes only that file. Not `async`
   * so two overlapping callers join the same Promise rather than racing.
   * See ../README.md#descriptorstore-refresh.
   */
  refresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doRefresh(): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.descriptorDir)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      const staleness = this.lastGoodRefreshAtMs === null ? 'never refreshed' : 'stale';
      this.onSkippedFile(
        this.descriptorDir,
        `directory unreadable (${staleness}): ${(error as Error).message}`
      );
      return;
    }

    const next = new Set<string>();
    for (const file of files) {
      const full = path.join(this.descriptorDir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(full, 'utf8'));
      } catch (error) {
        this.onSkippedFile(file, `unreadable or not valid JSON: ${(error as Error).message}`);
        continue;
      }
      if (!hasValidShapeForServing(raw)) {
        this.onSkippedFile(file, 'missing or malformed kind/hostname field');
        continue;
      }
      const hostname = servedHostnameOf(raw, this.zones);
      if (hostname === null) {
        this.onSkippedFile(file, 'descriptor is not eligible for a per-hostname certificate');
        continue;
      }
      if (!isSyntacticallyValidHostname(hostname)) {
        this.onSkippedFile(file, `derived hostname "${hostname}" is not a well-formed hostname`);
        continue;
      }
      next.add(hostname);
    }
    this.served = next;
    this.lastGoodRefreshAtMs = this.now();
  }
}
