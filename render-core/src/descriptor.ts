/**
 * The tenant descriptor: the one schema both reconcilers (the Pulumi
 * component, via CI, for paying tenants; the broker, via HTTP, for demos)
 * render from.
 *
 * Every difference between a demo, an entry tenant and a professional tenant
 * is a tagged union variant, never an absent field — an optional field would
 * let two descriptors differ by omission, which is how promotion quietly
 * becomes a migration instead of a re-point. `validate()` in `./validate.ts`
 * is the only place the cross-field rules below are checked; a caller that
 * re-implements one of them is exactly the failure mode this shared core
 * exists to remove.
 */

import type {
  AbsoluteUrl,
  DigestPinnedRef,
  EmailAddress,
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

/** Where Ghost's data lives. `Sqlite` is demo-only; a paying tenant is `MySql`. */
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
 * Where uploaded media lives, and Ghost's own image-optimisation behaviour
 * for it: resizing on upload and generating responsive derivatives on
 * demand. `Local` is demo-only; a paying tenant is `S3`. Optimisation is
 * configuration rather than a Ghost default because whether derivatives are
 * generated is a tenancy property, not an implementation detail — off for a
 * demo means one copy per upload instead of an unbounded set of them.
 */
export type MediaSpec =
  | {
      readonly kind: 'local';
      readonly path: string;
      readonly resize: boolean;
      readonly srcsets: boolean;
    }
  | {
      readonly kind: 's3';
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly resize: boolean;
      readonly srcsets: boolean;
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
 * own. `Ours.gated` must agree with `gate` — see `validate()`.
 */
export type HostnameSpec =
  | { readonly kind: 'ours'; readonly sub: string; readonly gated: boolean }
  | { readonly kind: 'theirs'; readonly fqdn: string; readonly verifiedAt: Instant };

/** The edge-level gate in front of a site. Tied to `kind` — see `validate()`. */
export type GateSpec =
  { readonly kind: 'none' } | { readonly kind: 'passphrase'; readonly argon2idHash: string };

/**
 * How a tenant's data is backed up. `BucketNative` carries the tenant's own
 * encryption recipient — exactly one per tenant, which is what makes
 * erasure a key destruction rather than a rewrite of every other tenant's
 * backup. `None` is for a demo, which is not backed up at all.
 */
export type BackupSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'bucket-native'; readonly encryptionRecipient: string };

/**
 * Whether a tenant may inject arbitrary script into its own site.
 *
 * `Blocked` for every kind, demos included — there is no `Open` variant to
 * construct. A grant or a managed injection requires a verified custom
 * domain (`hostname.kind = "theirs"`) and is never available to a demo —
 * see `validate()`.
 */
export type CodeInjectionSpec =
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'granted';
      readonly by: string;
      readonly reason: string;
      /**
       * An expiry is optional: a permanent grant with a review date tracked
       * elsewhere is a valid posture, not an incomplete one, so `null` (no
       * fixed expiry) is a legitimate value here rather than a gap.
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
 * The perceptual-hash safety axis. Both flags are on for every tenant today;
 * they are still per-descriptor because a perceptual false positive must
 * never be allowed to become terminal on its own.
 */
export interface SafetySpec {
  readonly near: boolean;
  readonly exact: boolean;
}

/**
 * The break-glass triple LLD-5 §07 hands to this schema: the broker's
 * Ed25519 public key, the tenant name a token's `aud` must equal, and the
 * one identity the adapter is allowed to produce a session for. Derived,
 * like `codeInjection` — nobody hand-sets these three, and `validate()`
 * refuses a descriptor carrying one or two of them (`enabled` requires all
 * three; there is no partial variant to construct). `disabled` for every
 * demo: a demo visitor already holds admin on their own disposable slot, so
 * there is nothing for a support identity to reach that they cannot already
 * reach — see `checkTierVariants` in `./validate.ts`.
 */
export type BreakGlassSpec =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'enabled';
      /** Ed25519 public key, base64 SPKI DER. Only the public half is ever
       * on a tenant — see `adapters/sso/README.md`. */
      readonly publicKey: string;
      /** Must equal this descriptor's own `slug` — see `validate()`'s
       * identity check. A mismatch would let one tenant's rendered config
       * accept a token minted for another tenant's audience. */
      readonly tenant: string;
      readonly supportIdentity: EmailAddress;
    };

export interface TenantDescriptor {
  /**
   * The schema version this descriptor was built against. A reconciler that
   * does not recognise the value must refuse it rather than render a stack
   * missing whatever a newer schema added.
   */
  readonly version: number;
  readonly kind: TenantKind;
  readonly slug: Slug;
  readonly siteUrl: AbsoluteUrl;
  readonly image: DigestPinnedRef;
  /** The one piece of prospect data this schema carries: the address Ghost creates the owner account with. */
  readonly ownerEmail: EmailAddress;
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
  readonly safety: SafetySpec;
  readonly breakGlass: BreakGlassSpec;
  readonly expiresAt: Instant | null;
}
