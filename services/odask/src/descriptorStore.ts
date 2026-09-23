import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { isSyntacticallyValidHostname, servedHostnameOf } from './hostname.js';

export interface DescriptorStoreOptions {
  readonly descriptorDir: string;
  readonly baseDomain: string;
  /** Defaults to `console.warn`; overridable so tests can capture it. */
  readonly onSkippedFile?: (file: string, reason: string) => void;
}

/**
 * A minimal, local shape check -- not render-core's `validate()`. `validate`
 * enforces cross-field invariants (siteUrl-vs-hostname, code-injection
 * preconditions, safety flags...) that are the harness's job to have
 * already run before a descriptor reaches this directory (LLD-5 §07
 * handoff: "LLD-3, the harness, gains a further gate"). Re-running the full
 * check here would duplicate that gate and give this service an opinion on
 * fields it never reads. What this service needs is narrower and load-
 * bearing on its own: is `hostname` shaped like one of the two declared
 * variants at all, so a corrupt or half-written file is excluded from the
 * served set rather than crashing the refresh or being read as some other
 * variant's fields.
 */
function hasValidHostnameShape(value: unknown): value is Pick<TenantDescriptor, 'hostname'> {
  if (typeof value !== 'object' || value === null || !('hostname' in value)) {
    return false;
  }
  const hostname = (value as { hostname: unknown }).hostname;
  if (typeof hostname !== 'object' || hostname === null || !('kind' in hostname)) {
    return false;
  }
  const kind = (hostname as { kind: unknown }).kind;
  if (kind === 'ours') {
    const sub = (hostname as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0;
  }
  if (kind === 'theirs') {
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
 */
export class DescriptorStore {
  private served: ReadonlySet<string> = new Set();
  private readonly descriptorDir: string;
  private readonly baseDomain: string;
  private readonly onSkippedFile: (file: string, reason: string) => void;

  constructor(options: DescriptorStoreOptions) {
    this.descriptorDir = options.descriptorDir;
    this.baseDomain = options.baseDomain;
    this.onSkippedFile =
      options.onSkippedFile ??
      ((file, reason) => console.warn(`odask: skipping ${file}: ${reason}`));
  }

  has(hostname: string): boolean {
    return this.served.has(hostname);
  }

  get size(): number {
    return this.served.size;
  }

  /**
   * Rebuilds the served set from the directory, atomically from a caller's
   * point of view: `has()` keeps answering from the previous set until this
   * completes, and a directory read failure leaves the previous set intact
   * rather than clearing it -- a transient read error must never turn every
   * hostname unserved. A per-file parse or shape failure is narrower: that
   * one file is excluded (fails closed on its own hostname only) and the
   * refresh continues.
   */
  async refresh(): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.descriptorDir)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      this.onSkippedFile(this.descriptorDir, `directory unreadable: ${(error as Error).message}`);
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
      if (!hasValidHostnameShape(raw)) {
        this.onSkippedFile(file, 'missing or malformed hostname field');
        continue;
      }
      const descriptor = raw as Pick<TenantDescriptor, 'hostname'>;
      const hostname = servedHostnameOf(descriptor as TenantDescriptor, this.baseDomain);
      if (!isSyntacticallyValidHostname(hostname)) {
        this.onSkippedFile(file, `derived hostname "${hostname}" is not a well-formed hostname`);
        continue;
      }
      next.add(hostname);
    }
    this.served = next;
  }
}
