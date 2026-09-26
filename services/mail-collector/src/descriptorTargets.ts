import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './log.js';

/** One host this collector may drain. `id` is the descriptor's own slug -- stable across refreshes, unlike the array position. */
export interface DrainTarget {
  readonly id: string;
  readonly baseUrl: string;
}

/**
 * What collectorLoop.ts actually depends on -- narrower than the concrete
 * `DescriptorTargetStore` class, so a test can drive the collector loop's
 * own membership logic (the reconcile/retire behaviour) against a plain
 * test double without also having to fake a descriptor directory on disk.
 * `DescriptorTargetStore` is this interface's one production
 * implementation, and the one place that is allowed to decide `targets`
 * from anything other than the tenant/demo descriptor.
 */
export interface TargetStore {
  readonly targets: readonly DrainTarget[];
  readonly isStale: boolean;
  refresh(): Promise<void>;
}

export interface DescriptorTargetStoreOptions {
  readonly descriptorDir: string;
  readonly shimPort: number;
  readonly maxStalenessMs: number;
  readonly log: Logger;
  readonly now?: () => number;
}

/**
 * A minimal, local shape check -- not render-core's `validate()`, the same
 * choice odask's DescriptorStore makes and for the same reason: `validate`
 * enforces cross-field invariants that are the harness's job to have
 * already run before a descriptor reaches this directory. What this
 * service needs is narrower: is the descriptor shaped enough to name one
 * live host, so a corrupt or half-written file is excluded from the drain
 * list rather than crashing the refresh.
 */
function hasValidShapeForDraining(value: unknown): value is {
  kind: 'demo' | 'tenant';
  slug: string;
  appHostIp: string;
  expiresAt: string | null;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind, slug, appHostIp, expiresAt } = value as Record<string, unknown>;
  if (kind !== 'demo' && kind !== 'tenant') {
    return false;
  }
  if (typeof slug !== 'string' || slug.length === 0) {
    return false;
  }
  if (typeof appHostIp !== 'string' || appHostIp.length === 0) {
    return false;
  }
  if (expiresAt !== null && typeof expiresAt !== 'string') {
    return false;
  }
  return true;
}

function isLive(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) {
    return true;
  }
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) ? false : expiresAtMs > nowMs;
}

/**
 * The drain list this collector's whole design turns on (LLD-6 §09,
 * load-bearing: "a host that is not in it is a host whose mail is never
 * collected"). Built by reading a directory of tenant/demo descriptor JSON
 * files -- the same descriptor every reconciler renders from -- never from
 * a separately maintained host list. A descriptor that expired, that fails
 * the shape check, or that simply is not on disk here contributes no
 * target, however reachable its host still is on the network.
 *
 * Mirrors odask's DescriptorStore: `targets` keeps answering from the last
 * good read while a refresh is in flight or fails, but only up to
 * `maxStalenessMs` -- past that, `targets` returns empty rather than
 * keep-draining a snapshot this service can no longer vouch for.
 */
export class DescriptorTargetStore implements TargetStore {
  private current: readonly DrainTarget[] = [];
  private readonly descriptorDir: string;
  private readonly shimPort: number;
  private readonly maxStalenessMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private lastGoodRefreshAtMs: number | null = null;
  // Guards against two refreshes racing -- see odask's DescriptorStore for
  // why this must not be `async` (an `async` fn always allocates a new
  // Promise even when returning an existing one, which would defeat the
  // point of a second caller joining the first read).
  private inFlight: Promise<void> | null = null;

  constructor(options: DescriptorTargetStoreOptions) {
    this.descriptorDir = options.descriptorDir;
    this.shimPort = options.shimPort;
    this.maxStalenessMs = options.maxStalenessMs;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  /** Fails closed once the last successful read is further in the past than `maxStalenessMs` -- including at boot, before any refresh has ever succeeded. */
  get targets(): readonly DrainTarget[] {
    if (this.isStale) {
      return [];
    }
    return this.current;
  }

  get isStale(): boolean {
    return (
      this.lastGoodRefreshAtMs === null ||
      this.now() - this.lastGoodRefreshAtMs > this.maxStalenessMs
    );
  }

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
      this.log.warn('descriptor_dir_unreadable', { error: (error as Error).message });
      return;
    }

    const nowMs = this.now();
    const next: DrainTarget[] = [];
    for (const file of files) {
      const full = path.join(this.descriptorDir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(full, 'utf8'));
      } catch (error) {
        this.log.warn('descriptor_unreadable', { file, error: (error as Error).message });
        continue;
      }
      if (!hasValidShapeForDraining(raw)) {
        this.log.warn('descriptor_malformed', { file });
        continue;
      }
      if (!isLive(raw.expiresAt, nowMs)) {
        continue;
      }
      next.push({ id: raw.slug, baseUrl: `http://${raw.appHostIp}:${this.shimPort}` });
    }
    this.current = next;
    this.lastGoodRefreshAtMs = nowMs;
  }
}
