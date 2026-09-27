/**
 * The falsifying test LLD-1 §06 names: compare `render(demo)` with
 * `render(transform(demo))`, placement held fixed. Every difference must be
 * attributable to the five unions -- `database`, `media`, `hostname`,
 * `gate`, `backup` -- or to `limits`, `caps` and `expiresAt`. A difference
 * in a name, a slug-derived path or a volume identity fails: those rebuild
 * the tenancy, and the design's own claim is that promoting a demo is a
 * re-point rather than a migration precisely because nothing here needs one
 * to.
 *
 * Run once per paid tier (D55: "five is five whichever tier is on the other
 * end"), each time with that tier's own `limits`/`media.resize`/
 * `media.srcsets` values taken directly from this repo's own
 * `entryTenantDescriptor()`/`professionalTenantDescriptor()` fixtures --
 * `transform()` invents no tier policy of its own; see `transform.ts`'s
 * module doc comment.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Port, Slug } from '../src/brand.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import { adaptersVolumeName, contentVolumeName } from '../src/naming.js';
import { render } from '../src/render.js';
import type { assertAttributablePromotionDiff as AssertAttributablePromotionDiffFn } from '../src/transform.js';
import {
  assertAttributablePromotionDiff,
  transform,
  type PromotionTargets,
} from '../src/transform.js';
import { validate } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

/** Narrows a fixture's `media` to its `s3` arm, or fails loudly -- every
 * paid-tenant fixture this test reads a tier's `resize`/`srcsets` from is
 * `s3` by construction (`checkTierVariants`), so a fixture that stopped
 * being `s3` is itself a finding, not a case to silently skip. */
function s3MediaOf(
  descriptor: TenantDescriptor
): Extract<TenantDescriptor['media'], { kind: 's3' }> {
  if (descriptor.media.kind !== 's3') {
    throw new Error(`expected an "s3" media fixture, got media.kind "${descriptor.media.kind}".`);
  }
  return descriptor.media;
}

/**
 * Deliberately outside every zone `TEST_ZONES` owns and RFC 2606-reserved,
 * matching `fixtures.ts`'s own test-only-domain convention, for the
 * operational fields `transform()` has no authority to decide
 * (`databaseHost`/`databasePort`/`mediaEndpoint`/`mediaRegion`/
 * `backupEncryptionRecipient`). The tier-differentiated fields
 * (`limits`/`mediaResize`/`mediaSrcsets`) are NOT invented here -- they are
 * read straight off this repo's own pre-existing, unmodified fixtures, so a
 * future change to what "entry" or "professional" means updates this test
 * for free rather than silently drifting from it.
 */
const PROMOTION_TARGETS_BY_TIER = {
  entry: (() => {
    const fixture = entryTenantDescriptor();
    return {
      databaseHost: 'db-promotion.test.invalid',
      databasePort: 3306 as Port,
      mediaEndpoint: 'https://s3-promotion.test.invalid',
      mediaRegion: 'eu-test',
      backupEncryptionRecipient: 'age1qpromotiontestrecipiententryonly',
      limits: fixture.limits,
      mediaResize: s3MediaOf(fixture).resize,
      mediaSrcsets: s3MediaOf(fixture).srcsets,
    };
  })(),
  professional: (() => {
    const fixture = professionalTenantDescriptor();
    return {
      databaseHost: 'db-promotion.test.invalid',
      databasePort: 3306 as Port,
      mediaEndpoint: 'https://s3-promotion.test.invalid',
      mediaRegion: 'eu-test',
      backupEncryptionRecipient: 'age1qpromotiontestrecipientproonly',
      limits: fixture.limits,
      mediaResize: s3MediaOf(fixture).resize,
      mediaSrcsets: s3MediaOf(fixture).srcsets,
    };
  })(),
} satisfies Record<'entry' | 'professional', PromotionTargets>;

// Non-vacuous, and a guard against the two fixtures drifting together:
// the two tiers' own targets must actually differ from each other, or
// running this test "for both tiers" would just be running it twice.
if (
  PROMOTION_TARGETS_BY_TIER.entry.mediaResize ===
    PROMOTION_TARGETS_BY_TIER.professional.mediaResize ||
  JSON.stringify(PROMOTION_TARGETS_BY_TIER.entry.limits) ===
    JSON.stringify(PROMOTION_TARGETS_BY_TIER.professional.limits)
) {
  throw new Error(
    'entryTenantDescriptor() and professionalTenantDescriptor() no longer differ in limits/media.resize -- ' +
      'update PROMOTION_TARGETS_BY_TIER (or this guard) to match whatever still tells the tiers apart.'
  );
}

function artefactMap(descriptor: TenantDescriptor): Map<string, string> {
  const artefacts = render(validate(descriptor, TEST_ZONES), TEST_ZONES);
  return new Map(artefacts.map((artefact) => [artefact.path, artefact.content]));
}

afterAll(() => {
  cleanupSabotageTmp();
});

describe.each([
  ['entry', PROMOTION_TARGETS_BY_TIER.entry] as const,
  ['professional', PROMOTION_TARGETS_BY_TIER.professional] as const,
])(
  'the falsifying test (LLD-1 §06), %s tier: transform() moves only the attributable set',
  (tierLabel, targets) => {
    it('promoting a demo changes only the five unions plus limits/caps/expiresAt', () => {
      const demo = validate(demoDescriptor(), TEST_ZONES);
      const tenant = transform(demo, TEST_ZONES, targets);

      // The transformed descriptor must itself be a valid paying tenant --
      // not merely "differs in the right places" but usable.
      validate(tenant, TEST_ZONES);

      // Placement (host address, ports, uid) is fixed test input, never
      // compared -- asserted equal outright, not merely allowed to differ.
      expect(tenant.appHostIp).toBe(demo.appHostIp);
      expect(tenant.ports).toEqual(demo.ports);
      expect(tenant.uid).toBe(demo.uid);

      // A name never changes: the slug survives promotion. Every derived
      // identity (database, bucket, stack directory) is keyed on it.
      expect(tenant.slug).toBe(demo.slug);

      // The assertion under test: every remaining difference is attributable.
      expect(() => assertAttributablePromotionDiff(demo, tenant)).not.toThrow();

      // Non-vacuous: the five unions and the three scalars actually did move
      // -- a comparator that "passed" because nothing changed at all would
      // not be testing anything.
      expect(tenant.kind).not.toBe(demo.kind);
      expect(tenant.database).not.toEqual(demo.database);
      expect(tenant.media).not.toEqual(demo.media);
      expect(tenant.hostname).not.toEqual(demo.hostname);
      expect(tenant.gate).not.toEqual(demo.gate);
      expect(tenant.backup).not.toEqual(demo.backup);
      expect(tenant.limits).not.toEqual(demo.limits);
      expect(tenant.expiresAt).not.toBe(demo.expiresAt);

      // The tier under test actually landed: `limits`/`media.resize`/
      // `media.srcsets` reflect the TARGET tier's own values, not some other
      // tier's -- the whole reason these three are `PromotionTargets` fields
      // rather than a constant `transform()` picks itself.
      expect(tenant.limits).toEqual(targets.limits);
      if (tenant.media.kind !== 's3') throw new Error('expected a promoted tenant to be s3 media');
      expect(tenant.media.resize).toBe(targets.mediaResize);
      expect(tenant.media.srcsets).toBe(targets.mediaSrcsets);

      // TransportSpec and codeInjection are the design's own examples of
      // fields that must NOT move (LLD-1 §06's figure caption: "TransportSpec
      // is identical across all three kinds, so it never moves"; "now both
      // are Blocked and it does not [move]"). `caps` likewise never moves --
      // unlike `limits`, it is not tier-differentiated (`runtime.ts`: "applies
      // identically to all three kinds").
      expect(tenant.transport).toEqual(demo.transport);
      expect(tenant.codeInjection).toEqual(demo.codeInjection);
      expect(tenant.caps).toEqual(demo.caps);
      expect(tenant.ownerEmail).toBe(demo.ownerEmail);
      expect(tenant.image).toBe(demo.image);
    });

    it('render(demo) vs render(transform(demo)): artefacts sourced from unmoved fields stay byte-identical', () => {
      const demo = validate(demoDescriptor(), TEST_ZONES);
      const tenant = transform(demo, TEST_ZONES, targets);
      const demoArtefacts = artefactMap(demo);
      const tenantArtefacts = artefactMap(tenant);

      // image.env: `image` is not one of the five unions or three scalars --
      // must be byte-identical.
      expect(tenantArtefacts.get('image.env')).toBe(demoArtefacts.get('image.env'));

      // ghost-settings.json (settings.ts) is a pure function of `codeInjection`
      // alone, which transform() never touches -- byte-identical.
      expect(tenantArtefacts.get('ghost-settings.json')).toBe(
        demoArtefacts.get('ghost-settings.json')
      );

      // identity.json (identity.ts): `stackName`/`contentVolume`/
      // `adaptersVolume` are pure functions of `slug` alone, and
      // `appHostPrivateIp` is placement, held fixed -- none of these four may
      // move. Only `databaseName`/`mediaBucket`, sourced from the
      // database/media unions, may.
      const demoIdentity = JSON.parse(demoArtefacts.get('identity.json')!) as Record<
        string,
        unknown
      >;
      const tenantIdentity = JSON.parse(tenantArtefacts.get('identity.json')!) as Record<
        string,
        unknown
      >;
      for (const field of [
        'slug',
        'uid',
        'stackName',
        'contentVolume',
        'adaptersVolume',
        'appHostPrivateIp',
      ]) {
        expect(tenantIdentity[field]).toEqual(demoIdentity[field]);
      }
      expect(tenantIdentity.databaseName).not.toEqual(demoIdentity.databaseName);
      expect(tenantIdentity.mediaBucket).not.toEqual(demoIdentity.mediaBucket);

      // edge.json (edge.ts#renderEdgeSiteBlock): sourced from exactly the two
      // unions that DO legitimately change under promotion -- `hostname` and
      // `gate` -- which is exactly why it needs checking rather than skipping:
      // an attributable union changing does not exempt what it renders into.
      const demoEdge = JSON.parse(demoArtefacts.get('edge.json')!) as Record<string, unknown>;
      const tenantEdge = JSON.parse(tenantArtefacts.get('edge.json')!) as Record<string, unknown>;

      // Load-bearing per edge.ts's own doc comment: `admittedHostname` is
      // `null` for every demo, precisely so a reusable slot's current name
      // never reaches a public, append-only CT log. Promotion is exactly the
      // transition that must flip it to non-null -- a promoted tenant stuck
      // at `null` could never obtain an on-demand certificate.
      expect(demoEdge.admittedHostname).toBeNull();
      expect(tenantEdge.admittedHostname).not.toBeNull();
      expect(tenantEdge.admittedHostname).toBe(tenantEdge.displayHostname);

      // gate: a demo is always gated (INV-2); a promoted tenant never is.
      expect(demoEdge.gate).toEqual({ kind: 'passphrase', argon2idHash: expect.any(String) });
      expect(tenantEdge.gate).toEqual({ kind: 'none' });

      // Everything else in edge.json (`requestBodyMaxSize`/
      // `contentSecurityPolicy`) comes from `uploadLimits()`, which
      // `runtime.ts`'s own doc comment says "applies identically to all three
      // kinds" -- no kind-dependent input feeds it. Asserting the FULL set of
      // changed top-level keys (not just that the two expected ones changed)
      // is what makes this non-vacuous: any other difference, including a
      // future kind-dependent `requestBodyMaxSize`, fails here by not being
      // in the allowed set.
      const edgeKeys = new Set([...Object.keys(demoEdge), ...Object.keys(tenantEdge)]);
      const edgeChanged = new Set(
        [...edgeKeys].filter(
          (key) => JSON.stringify(demoEdge[key]) !== JSON.stringify(tenantEdge[key])
        )
      );
      expect(edgeChanged).toEqual(new Set(['displayHostname', 'admittedHostname', 'gate']));

      // compose.yml (compose.ts): the Compose project `name` and both content/
      // adapters volume names are pure functions of `slug` alone -- a leak of
      // a different name here is exactly "a slug-derived path or a volume
      // identity" failing.
      const composeProjectName = (text: string): string | undefined =>
        /^name: (.+)$/m.exec(text)?.[1];
      const demoCompose = demoArtefacts.get('compose.yml')!;
      const tenantCompose = tenantArtefacts.get('compose.yml')!;
      expect(composeProjectName(tenantCompose)).toBe(composeProjectName(demoCompose));
      expect(composeProjectName(demoCompose)).toBeDefined();
      for (const volume of [contentVolumeName(demo.slug), adaptersVolumeName(demo.slug)]) {
        expect(demoCompose).toContain(volume);
        expect(tenantCompose).toContain(volume);
      }
      // Non-vacuous: compose.yml is not byte-identical overall (database,
      // media and limits are rendered into its environment section).
      expect(tenantCompose).not.toBe(demoCompose);

      // secrets.env (render.ts#renderSecretsTemplate): the header names the
      // path this same slug alone derives, in both -- the file's own location
      // never depends on kind.
      const secretsPath = (text: string): string | undefined =>
        /at (\/etc\/branchleft\/\S+\.env)\./.exec(text)?.[1];
      expect(secretsPath(tenantArtefacts.get('secrets.env')!)).toBe(
        secretsPath(demoArtefacts.get('secrets.env')!)
      );
      expect(secretsPath(demoArtefacts.get('secrets.env')!)).toBeDefined();

      // provision.sh (render.ts#renderProvisionScript): the tenant's own
      // volume-provisioning command must name this same slug, never another.
      expect(tenantArtefacts.get('provision.sh')).toContain(`'${demo.slug}'`);
    });

    it(`${tierLabel} tier: control case: a completely unrelated field change is rejected, naming the field`, () => {
      const demo = validate(demoDescriptor(), TEST_ZONES);
      const tenant = transform(demo, TEST_ZONES, targets);
      // `ownerEmail` is not one of the five unions and not a per-kind scalar
      // -- transform() never touches it, so a descriptor with it changed by
      // hand must be rejected, and rejected by name.
      const sabotagedByHand: TenantDescriptor = {
        ...tenant,
        ownerEmail: 'someone-else@example.com' as TenantDescriptor['ownerEmail'],
      };
      expect(() => assertAttributablePromotionDiff(demo, sabotagedByHand)).toThrow(/ownerEmail/);
    });
  }
);

describe('transform() itself', () => {
  it("refuses to promote a demo whose declared kind is already 'tenant'", () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);
    expect(() =>
      transform({ ...demo, kind: 'tenant' }, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.professional)
    ).toThrow(/kind/);
  });
});

describe('CONTROL CASE — sabotage: the comparator itself can be made to miss a renamed tenancy', () => {
  it('a comparator mutated to also allow "slug" accepts a renamed slug; the real one rejects it, naming "slug"', async () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);
    const tenant = transform(demo, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.professional);
    // One extra field, changed by hand, beyond anything transform() itself
    // ever touches -- LLD-1 §06's own control case: "transform a
    // descriptor, change one extra field by hand". A renamed slug is
    // exactly the failure mode the story names: "a difference in a name...
    // fails -- those rebuild the tenancy."
    const renamedTenancy: TenantDescriptor = { ...tenant, slug: 'renamed-co' as Slug };

    // RED: mutate transform.ts's real ATTRIBUTABLE_PROMOTION_FIELDS set to
    // also allow 'slug' -- the one edit that would let a renamed tenancy
    // pass this check unnoticed.
    const sabotaged = await importSabotaged<{
      assertAttributablePromotionDiff: typeof AssertAttributablePromotionDiffFn;
    }>('transform.ts', (source) => {
      const target = "  'kind',\n  'database',";
      if (!source.includes(target)) {
        throw new Error(
          'sabotage target string not found in transform.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(target, "  'kind',\n  'slug',\n  'database',");
    });
    expect(() => sabotaged.assertAttributablePromotionDiff(demo, renamedTenancy)).not.toThrow();

    // GREEN: the real, unmutated module still rejects it, naming the field.
    expect(() => assertAttributablePromotionDiff(demo, renamedTenancy)).toThrow(/slug/);
  });
});
