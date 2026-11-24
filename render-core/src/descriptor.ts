/**
 * The tenant descriptor: the one schema both reconcilers (the Pulumi
 * component for paying tenants, the broker for demos) render from. Every
 * tier difference is a tagged union variant, never an absent field. See
 * descriptor.md#the-tenant-descriptor.
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
 * demand. `Local` is demo-only; a paying tenant is `S3` (its own bucket,
 * kept until the storage gateway is live) or `Gateway`. Optimisation is
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
    }
  | {
      /** One folder in a shared shard bucket, reached only through the
       * storage gateway with a gateway-minted key. Replaces `s3` (a bucket
       * and a Hetzner key per tenant) once the gateway is live. See
       * descriptor.md#gateway-media. */
      readonly kind: 'gateway';
      /** The gateway's https origin, which Ghost signs its requests to. */
      readonly endpoint: string;
      readonly region: string;
      /** The shared shard bucket the tenant's folder was assigned to:
       * recorded at provisioning, never computed. */
      readonly shard: string;
      /** The tenant's opaque random folder, Ghost's `tenantPrefix`. Never
       * the slug: it is in every published media URL. */
      readonly folder: string;
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
 * The descriptor's sending identity: a demo carries only a local part, a
 * tenant signs its own domain. See descriptor.md#sending-identity-spec.
 */
export type SendingIdentitySpec =
  | { readonly kind: 'demo'; readonly localPart: string }
  | { readonly kind: 'tenant'; readonly domain: string; readonly dkimSelector: string };

/**
 * Whether mail is enabled at all, and the two ceilings LLD-6 §05 names as
 * demo mail's whole containment argument: "per slot: enough to try sign-up
 * and a test send… per estate: a hard cap all demo slots share." Both
 * ceilings are descriptor fields for every kind, not only a demo — a
 * paying tenant's own anti-abuse ceiling is the same shape, so no sixth
 * field exists for it. Neither ceiling is enforced here: counting sent
 * mail against them is the mail spool's job (LLD-6), not this package's —
 * `render()` carries the numbers through, it never reads a send count.
 */
export interface MailSpec {
  readonly enabled: boolean;
  readonly ceiling: number;
  readonly estateCeiling: number;
  readonly identity: SendingIdentitySpec;
  /**
   * Which sending target the mail collector uses for this host's drained
   * mail. Absent means `mx1`, so a descriptor written before this field
   * existed means exactly what it always did. `render()` ignores it; the host's
   * mail spool reads it through `mailSpoolNeedsDrainOutcomes`. See
   * mail.md#mail-route.
   */
  readonly route?: MailRouteSpec;
  /**
   * Where Ghost's bulk-mail client submits newsletters. Absent means the
   * host's own mail spool, so a descriptor written before this field existed
   * renders exactly what it always did. See mail.md#bulk-endpoint.
   */
  readonly bulk?: BulkMailSpec;
}

/**
 * A provider-neutral bulk-mail endpoint: the https origin Ghost's bulk client
 * submits to, the account identifier it addresses there, and the *name* of
 * the secrets-file key that holds the credential. It carries no credential
 * value and no provider name; the value reaches the host only through
 * `/etc/branchleft/<slug>.env`. See mail.md#bulk-endpoint.
 */
export interface BulkMailSpec {
  /** An https origin (scheme and host, optional port, no path, no userinfo). */
  readonly endpoint: string;
  /** The account identifier Ghost addresses on the endpoint (its `domain`). */
  readonly domain: string;
  /** The secrets-file key holding the credential: `GHOST_BULK_` then upper-case letters, digits and `_`. */
  readonly credentialRef: string;
}

/** The two sending targets the collector may be told to use. */
export type MailRoute = 'mx1' | 'sweego';

/**
 * A strict object, not a bare string, so a field can sit beside `primary`
 * without renaming anything. It carries no credential, no host and no
 * fallback target: the fallback is fixed in the collector's code and has no
 * descriptor field. `sweegoAllowance` is the tenant's messages per UTC
 * calendar month through Sweego, present exactly when `primary` is `sweego`.
 * See mail.md#mail-route.
 */
export interface MailRouteSpec {
  readonly primary: MailRoute;
  readonly sweegoAllowance?: number;
}

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
  /**
   * Which verdict source the scanning adapter is given. Absent is `'none'`:
   * the adapter has no source and refuses every upload. `'production'`
   * names the slot's local verdict socket, and a demo may not name it. See
   * environment.md#verdict-source.
   */
  readonly verdictSource?: VerdictSourceKind;
  /**
   * The inbound listener the safety service dials on the host end. Names the
   * port and that the host end serves its own certificate. It carries no
   * address (the private address is a host-side matter) and no key or
   * certificate path. Only with `verdictSource: 'production'`. See
   * environment.md#verdict-source.
   */
  readonly inbound?: VerdictInboundSpec;
}

/** The values `safety.verdictSource` may take. See SafetySpec. */
export type VerdictSourceKind = 'none' | 'production';

/** The values `safety.inbound` names. See SafetySpec. */
export interface VerdictInboundSpec {
  readonly port: number;
  readonly tls: 'pinned-private';
}

/**
 * The break-glass triple: the broker's Ed25519 public key, the tenant name a
 * token's `aud` must equal, and the identity the adapter may produce a
 * session for. See descriptor.md#break-glass-spec.
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

/**
 * Tenant analytics. Off by default: an absent field and `kind: 'off'` mean
 * the same thing, and render no analytics keys at all. `on` names the
 * tenant's site identifier, which must be a lower-case UUID and is refused
 * for a demo. See environment.ts (analyticsEnvironment) and LLD-11 section 09.
 */
export type AnalyticsSpec =
  { readonly kind: 'off' } | { readonly kind: 'on'; readonly siteUuid: string };

/**
 * Tenant federation (ActivityPub). Off by default: an absent field and
 * `kind: 'off'` mean the same thing, and the Network setting stays locked.
 * `on` unlocks the setting and is refused for a demo, so no demo can ever
 * render with federation. See environment.ts (federationEnvironment) and
 * environment.md#social-web-lock.
 */
export type ActivityPubSpec = { readonly kind: 'off' } | { readonly kind: 'on' };

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
  readonly mail: MailSpec;
  readonly hostname: HostnameSpec;
  readonly gate: GateSpec;
  readonly backup: BackupSpec;
  readonly codeInjection: CodeInjectionSpec;
  readonly limits: LimitsSpec;
  readonly caps: ResourceCaps;
  readonly safety: SafetySpec;
  readonly breakGlass: BreakGlassSpec;
  readonly expiresAt: Instant | null;
  /** Absent means off (LLD-11 section 09). */
  readonly analytics?: AnalyticsSpec;
  /** Absent means off (environment.md#social-web-lock). */
  readonly activitypub?: ActivityPubSpec;
}

/**
 * A paying tenant's descriptor as its own repository may commit it: every
 * field but `ownerEmail`, which is a person's address and reaches the host
 * only through the secrets file. See descriptor.md#tenant-stack-descriptor.
 */
export type TenantStackDescriptor = Omit<TenantDescriptor, 'ownerEmail'>;
