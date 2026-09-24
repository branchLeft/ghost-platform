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
 * A minimal, local shape check -- not render-core's `validate()`. `validate`
 * enforces cross-field invariants (siteUrl-vs-hostname, code-injection
 * preconditions, safety flags...) that are the harness's job to have
 * already run before a descriptor reaches this directory (LLD-5 §07
 * handoff: "LLD-3, the harness, gains a further gate"). Re-running the full
 * check here would duplicate that gate and give this service an opinion on
 * fields it never reads. What this service needs is narrower and load-
 * bearing on its own: is the descriptor shaped enough for render-core's
 * `servedHostnameOf` to read `kind` and `hostname` at all, so a corrupt or
 * half-written file is excluded from the served set rather than crashing
 * the refresh or being read as some other variant's fields.
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
 * The in-memory served-hostname set an ask asks against, refreshed from a
 * directory of one JSON descriptor file per tenant. A negative answer costs
 * no read of anything (LLD-5 E3): `has()` only ever touches the `Set`
 * `refresh()` last built, never the filesystem or a per-request query.
 *
 * Which hostname a descriptor derives to -- and which descriptors must
 * never be served at all (a demo's `ours` hostname; a `theirs` fqdn that is
 * itself one of the platform's own owned domains; a multi-label `ours`
 * sub) -- is render-core's `servedHostnameOf`, not a copy of it: a second
 * implementation of that logic is exactly how it diverged the first time.
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
   * Rebuilds the served set from the directory, atomically from a caller's
   * point of view: `has()` keeps answering from the previous set until this
   * completes, and a directory read failure leaves the previous set intact
   * rather than clearing it -- up to `maxStalenessMs`, past which `has()`
   * fails closed on its own regardless of what `served` still holds. A
   * per-file parse or shape failure is narrower: that one file is excluded
   * (fails closed on its own hostname only) and the refresh continues.
   *
   * A second call while one is already running joins the first rather than
   * starting a competing read.
   */
  // Not `async`, deliberately: an `async` function always wraps its return
  // value in a *new* Promise, even when the body returns an existing one --
  // which would make two overlapping callers each hold a different Promise
  // object for the same underlying read, defeating the point of joining.
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
