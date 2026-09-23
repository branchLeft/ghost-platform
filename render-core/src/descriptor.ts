/**
 * The tenant descriptor: the one schema both reconcilers (the Pulumi
 * component, via CI, for paying tenants; the broker, via HTTP, for demos)
 * render from.
 *
 * Every difference between a demo, an entry tenant and a professional tenant
 * is a tagged union variant, never an absent field — an optional field would
 * let two descriptors differ by omission, which is how promotion quietly
 * becomes a migration instead of a re-point. `validate()` in `./validate.ts`
 * is the only place the three cross-field invariants below are checked; a
 * caller that re-implements one of them is exactly the failure mode this
 * shared core exists to remove.
 */

import type {
  AbsoluteUrl,
  DigestPinnedRef,
  Instant,
  Port,
  PrivateIpV4,
  Slug,
  TenantUid,
} from './brand.js';

export type TenantKind = 'demo' | 'tenant';

export interface PortTriple {
  /** Slot colour A — one of the pair a blue/green deploy swaps between. */
  readonly a: Port;
  /** Slot colour B. */
  readonly b: Port;
  /** The sidecar port the edge probes; not Ghost's own port. */
  readonly health: Port;
}

/**
 * Where Ghost's data lives. `Sqlite` is demo-only — after D55 both paid
 * tiers resolve to the same `MySql` variant, so promotion never needs a
 * fourth code path here.
 */
export type DatabaseSpec =
  | { readonly kind: 'sqlite'; readonly path: string }
  | {
      readonly kind: 'mysql';
      readonly host: string;
      readonly port: Port;
      readonly name: string;
      readonly user: string;
    };

/**
 * Where uploaded media lives. Amended 2026-09-22 (D55): `Local` is demo-only
 * — both paid tiers moved to OVHcloud object storage, so `S3` covers entry
 * and professional alike. INV-3 below is what a `S3` variant obliges on
 * `backup`.
 */
export type MediaSpec =
  | { readonly kind: 'local'; readonly path: string }
  | {
      readonly kind: 's3';
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
    };

/**
 * Ghost's mail-sending path. Identical across every kind — the one union
 * that promotion never touches, because the shim's transport does not vary
 * by tier.
 */
export type TransportSpec =
  | { readonly kind: 'queue'; readonly path: string }
  | { readonly kind: 'smtp'; readonly host: string; readonly port: Port; readonly user: string };

/**
 * The hostname a tenant is reached on. `Theirs` (a verified custom domain)
 * is a precondition a code-injection grant checks, never a grant on its
 * own — see `validate()`.
 */
export type HostnameSpec =
  | { readonly kind: 'ours'; readonly sub: string; readonly gated: boolean }
  | { readonly kind: 'theirs'; readonly fqdn: string; readonly verifiedAt: Instant };

/** The edge-level gate in front of a site. INV-2 ties this to `kind`. */
export type GateSpec =
  { readonly kind: 'none' } | { readonly kind: 'passphrase'; readonly argon2idHash: string };

/**
 * How a tenant's data is backed up. The `Platform { target }` arm this union
 * carried until D55 has no remaining user — once the entry tier's media
 * became `s3`, INV-3 forces its backup to `bucket-native` too, so every kind
 * now resolves to one of the two variants below. Removed here rather than
 * kept unreachable (an implementation decision the design left open).
 */
export type BackupSpec = { readonly kind: 'none' } | { readonly kind: 'bucket-native' };

/**
 * Whether a tenant may inject arbitrary script into its own site.
 *
 * `Blocked` for every kind, demos included — there is no `Open` variant to
 * construct, which is INV-1 enforced by the type system for any caller
 * building a descriptor through this module. `validate()` still checks it at
 * runtime, because JSON arriving over HTTP is not type-checked.
 */
export type CodeInjectionSpec =
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'granted';
      readonly by: string;
      readonly reason: string;
      /**
       * Marked incidental in the design: a permanent grant with a review
       * date elsewhere satisfies the ruling as written, so `null` (no fixed
       * expiry) is a valid value here, not a gap.
       */
      readonly until: Instant | null;
    }
  | { readonly kind: 'managed'; readonly head: string; readonly foot: string };

/**
 * Ghost's host-limits framework. Not yet exhaustive — the design flags most
 * of Ghost's limit list as still-open work (what each limit actually
 * enforces needs stating next to it) and names only these two explicitly.
 */
export interface LimitsSpec {
  readonly membersCap: number | null;
  readonly staffCap: number | null;
}

/**
 * The container resource ceiling applied identically to every kind. Mirrors
 * the shape `infra/tenant/runtime.ts` already renders from — duplicated
 * rather than imported, so this package's dependency closure stays
 * independent of `infra/tenant`'s.
 */
export interface ResourceCaps {
  readonly cpus: string;
  readonly cpuShares: number;
  readonly pidsLimit: number;
  readonly nofile: number;
}

/**
 * Ghost's own image-optimisation behaviour: resizing on upload and
 * generating responsive derivatives on demand. Configuration, so a
 * descriptor field rather than a Ghost default — off for demos means one
 * copy per upload instead of an unbounded set of derivatives.
 */
export interface ContentSpec {
  readonly resize: boolean;
  readonly srcsets: boolean;
}

/**
 * The perceptual-hash safety axis. Both flags are on for every tenant today;
 * they are still per-descriptor because a perceptual false positive must
 * never be allowed to become terminal on its own.
 */
export interface SafetySpec {
  readonly near: boolean;
  readonly exact: boolean;
}

export interface TenantDescriptor {
  readonly kind: TenantKind;
  readonly slug: Slug;
  readonly siteUrl: AbsoluteUrl;
  readonly image: DigestPinnedRef;
  readonly uid: TenantUid;
  readonly ports: PortTriple;
  readonly appHostIp: PrivateIpV4;
  readonly database: DatabaseSpec;
  readonly media: MediaSpec;
  readonly transport: TransportSpec;
  readonly hostname: HostnameSpec;
  readonly gate: GateSpec;
  readonly backup: BackupSpec;
  readonly codeInjection: CodeInjectionSpec;
  readonly limits: LimitsSpec;
  readonly caps: ResourceCaps;
  readonly content: ContentSpec;
  readonly safety: SafetySpec;
  readonly expiresAt: Instant | null;
}
