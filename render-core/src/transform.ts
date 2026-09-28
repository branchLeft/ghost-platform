/**
 * The demo-to-tenant promotion transform LLD-1 §06 names: "transform() --
 * five unions + per-kind scalars". Moves exactly the five unions the
 * design's falsifying claim names -- `database`, `media`, `hostname`,
 * `gate`, `backup` -- plus `mail`'s own sending identity (LLD-6 §09's own
 * handoff of a sixth attributable field to this schema: a demo's
 * local-part identity becomes the tenant's own signed domain, the same
 * re-point every other union gets, never a value this schema invents) and
 * the three per-kind scalars that are not unions but still differ by kind:
 * `limits`, `caps`, `expiresAt`. Everything else on the descriptor, `slug`
 * above all, survives unchanged: promotion is a re-point of the
 * configuration, never a migration (LLD-1 §06's own closing claim, and the
 * reason a name, a slug-derived path or a volume identity is exactly what
 * `assertAttributablePromotionDiff` below rejects).
 *
 * Five things this function deliberately does not decide, because deciding
 * them here would be inventing operational or tier policy the design does
 * not fix:
 * - Where the tenant's database and media bucket physically live
 *   (`targets.databaseHost`/`databasePort`/`mediaEndpoint`/`mediaRegion`) --
 *   no more this package's job to pick than `appHostIp` is (`render()`'s own
 *   doc comment: this package never derives a host address; a caller
 *   supplies one).
 * - The tenant's own backup encryption recipient
 *   (`targets.backupEncryptionRecipient`) -- a real per-tenant key
 *   identity assigned once at promotion by whatever process manages that
 *   recipient. A schema-level transform has no key-generation authority.
 * - The tenant's own signed sending domain and DKIM selector
 *   (`targets.mailIdentity`) -- a real domain-verification and DNS fact
 *   (LLD-6 §06) this schema has no way to confirm, the same reasoning
 *   `backupEncryptionRecipient` above already carries. A missing target
 *   here is refused by name below, not defaulted.
 * - The target tier's `limits` (`targets.limits`) -- this repo's own
 *   `test/fixtures.ts` already encodes a tier-differentiated model here
 *   (`entryTenantDescriptor()`: capped; `professionalTenantDescriptor()`:
 *   uncapped), and `environment.ts#hostLimitsEnvironment` renders it
 *   straight into the Compose environment Ghost reads
 *   (`config.get('hostSettings:limits')`) -- so a hardcoded value here would
 *   ship one tier's entitlement to every promotion regardless of what was
 *   actually bought. There is no tier-neutral default: even "uncapped" is
 *   the professional tier's own value, not an absence of one.
 * - `media.resize`/`media.srcsets` (`targets.mediaResize`/`mediaSrcsets`) --
 *   the same fixtures encode these as tier-differentiated too, and LLD-1
 *   §03b states plainly that "whether they are on is a tenancy property,
 *   not an implementation detail."
 *
 * `caps` is the one per-kind scalar this function *does* carry over
 * unchanged from the demo, because it is not tier-differentiated at all:
 * `descriptor.ts#ResourceCaps` and `runtime.ts`'s own doc comments both
 * state the container resource ceiling "applies identically to every
 * kind"/"to all three kinds" -- unlike `limits`, there is no tier split to
 * preserve here.
 */

import type { AbsoluteUrl, Port } from './brand.js';
import { FieldValidationError } from './brand.js';
import type { LimitsSpec, SendingIdentitySpec, TenantDescriptor } from './descriptor.js';
import { databaseAndUserName } from './naming.js';
import { mediaBucketName } from './media.js';
import type { ZoneConfig } from './validate.js';

/** Everything a promotion supplies that this schema cannot derive from the
 * demo descriptor's own fields -- see the module doc comment. `limits`,
 * `mediaResize` and `mediaSrcsets` have no default for the same reason
 * `databaseHost` has none: each is a real tier/operational decision, and
 * every value including "uncapped" is itself one tier's answer, not a
 * tier-neutral fallback. */
export interface PromotionTargets {
  readonly databaseHost: string;
  readonly databasePort: Port;
  readonly mediaEndpoint: string;
  readonly mediaRegion: string;
  readonly mediaResize: boolean;
  readonly mediaSrcsets: boolean;
  readonly backupEncryptionRecipient: string;
  readonly limits: LimitsSpec;
  /** Shaped exactly as `SendingIdentitySpec`'s `tenant` arm, `kind` held
   * back: `transform()` is the one place that writes `kind: 'tenant'`,
   * the same way it writes `database.kind`/`media.kind` rather than taking
   * them as promotion input. */
  readonly mailIdentity: Omit<Extract<SendingIdentitySpec, { readonly kind: 'tenant' }>, 'kind'>;
}

/**
 * The top-level `TenantDescriptor` fields a promotion may legitimately
 * change: the five unions LLD-1 §06 names, plus `mail`'s sending identity
 * (LLD-6 §09) and the three per-kind scalars. `kind` and `siteUrl` are
 * folded in here too rather than tracked as a
 * separate bucket -- `kind` is the discriminant the whole transform exists
 * to flip, and `siteUrl` is `validate()`'s own single-cause consequence of
 * `hostname` changing (`checkSiteUrlMatchesHostname`), never an
 * independent union of its own.
 */
export const ATTRIBUTABLE_PROMOTION_FIELDS: ReadonlySet<keyof TenantDescriptor> = new Set([
  'kind',
  'database',
  'media',
  'hostname',
  'gate',
  'backup',
  'mail',
  'siteUrl',
  'limits',
  'caps',
  'expiresAt',
]);

/** Thrown by `assertAttributablePromotionDiff`, naming every field the
 * attributable set does not cover -- a name, a slug-derived path or a
 * volume identity chief among them (LLD-1 §06's own failure examples). */
export class UnattributedPromotionDiffError extends Error {
  constructor(public readonly fields: readonly string[]) {
    super(
      `promotion diff touches field(s) outside the five unions, mail's sending identity, and ` +
        `limits/caps/expiresAt: ` +
        `${fields.join(', ')}. A difference in a name, a slug-derived path or a volume identity ` +
        `rebuilds the tenancy and must never pass unnoticed.`
    );
    this.name = 'UnattributedPromotionDiffError';
  }
}

/**
 * `JSON.stringify` equality is enough here: every `TenantDescriptor` field
 * is itself plain JSON-shaped data (branded strings, numbers, nested plain
 * objects, `null`) -- there is no `Date`, `Map`, class instance or cycle
 * anywhere in the schema for a stringify comparison to get wrong.
 */
function changedTopLevelFields(
  before: TenantDescriptor,
  after: TenantDescriptor
): Array<keyof TenantDescriptor> {
  const beforeKeys = Object.keys(before) as Array<keyof TenantDescriptor>;
  const afterKeys = Object.keys(after) as Array<keyof TenantDescriptor>;
  const keys = new Set<keyof TenantDescriptor>([...beforeKeys, ...afterKeys]);
  const changed: Array<keyof TenantDescriptor> = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * The falsifying test's own assertion, factored out of `test/transform.test.ts`
 * so a real promotion caller can run the identical check against its own
 * before/after descriptors, not only a test fixture. Throws
 * `UnattributedPromotionDiffError`, naming every offending field, the first
 * time `after` differs from `before` anywhere `ATTRIBUTABLE_PROMOTION_FIELDS`
 * does not allow.
 */
export function assertAttributablePromotionDiff(
  before: TenantDescriptor,
  after: TenantDescriptor
): void {
  const changed = changedTopLevelFields(before, after);
  const unattributed = changed.filter((field) => !ATTRIBUTABLE_PROMOTION_FIELDS.has(field));
  if (unattributed.length > 0) {
    throw new UnattributedPromotionDiffError(unattributed);
  }
}

// Cast, not validated here: `render()`'s own `assertAllocationShape` and
// `validate()`'s `checkSiteUrlMatchesHostname` both re-check every
// interpolated field before it reaches an artefact, matching this
// package's own pattern of trusting a branded type only after a real
// validator has run (`brand.ts`'s doc comment) -- a caller that skips
// `validate()` after `transform()` gets a named refusal there, not here.
function promotedSiteUrl(sub: string, platformZone: string): AbsoluteUrl {
  return `https://${sub}.${platformZone}` as AbsoluteUrl;
}

/**
 * Promotes a demo descriptor to a paying tenant descriptor, placement held
 * fixed: `appHostIp`, `ports` and `uid` are carried over unchanged, exactly
 * as LLD-1 §06 requires ("supplied as fixed test input rather than
 * compared") -- a caller re-pointing to a different host or port triple is
 * a placement decision this function does not make either. `slug` survives
 * unchanged for the same reason: it is the one field every derived name
 * (the database identity, the media bucket, the stack directory) is keyed
 * on, and the whole claim under test is that none of those move.
 *
 * `demo.hostname` must be `"ours"` -- the only shape a valid demo can carry
 * (`validate.ts#checkTierVariants`) -- and its `sub` survives unchanged,
 * re-pointed from the demo zone to the platform zone and ungated: LLD-1
 * §06's own words for the default outcome, "a gated random subdomain on
 * the demo domain becomes an ungated subdomain of sites.<platform-domain>".
 * A promotion onto the customer's own verified domain is a real, separate
 * path this function does not build: it needs a verification timestamp
 * this schema-level transform has no way to obtain honestly, so choosing
 * one here would be inventing the very policy this story's premise check
 * is supposed to catch.
 */
export function transform(
  demo: TenantDescriptor,
  zones: Pick<ZoneConfig, 'platformZone'>,
  targets: PromotionTargets
): TenantDescriptor {
  if (demo.kind !== 'demo') {
    throw new FieldValidationError(
      'kind',
      `transform() promotes a demo descriptor; got kind "${demo.kind}".`
    );
  }
  if (demo.hostname.kind !== 'ours') {
    throw new FieldValidationError(
      'hostname',
      `a valid demo always carries hostname.kind "ours" -- got "${demo.hostname.kind}", which ` +
        `checkTierVariants() should already have rejected before this descriptor reached here.`
    );
  }
  if (!targets.mailIdentity || !targets.mailIdentity.domain || !targets.mailIdentity.dkimSelector) {
    throw new FieldValidationError(
      'mailIdentity',
      `transform() requires targets.mailIdentity (the promoted tenant's own signed sending ` +
        `domain and DKIM selector) to write the promoted descriptor's mail identity -- there is ` +
        `no tier-neutral default, the same reason backupEncryptionRecipient has none.`
    );
  }

  const slug = demo.slug;
  const sqlIdentity = databaseAndUserName(slug);

  return {
    ...demo,
    kind: 'tenant',
    siteUrl: promotedSiteUrl(demo.hostname.sub, zones.platformZone),
    database: {
      kind: 'mysql',
      host: targets.databaseHost,
      port: targets.databasePort,
      name: sqlIdentity,
      user: sqlIdentity,
    },
    media: {
      kind: 's3',
      endpoint: targets.mediaEndpoint,
      region: targets.mediaRegion,
      bucket: mediaBucketName(slug),
      resize: targets.mediaResize,
      srcsets: targets.mediaSrcsets,
    },
    hostname: { kind: 'ours', sub: demo.hostname.sub, gated: false },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: targets.backupEncryptionRecipient },
    mail: {
      ...demo.mail,
      identity: {
        kind: 'tenant',
        domain: targets.mailIdentity.domain,
        dkimSelector: targets.mailIdentity.dkimSelector,
      },
    },
    limits: targets.limits,
    expiresAt: null,
  };
}
