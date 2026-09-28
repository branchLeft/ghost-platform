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
import type { renderEdgeSiteBlock as RenderEdgeSiteBlockFn } from '../src/edge.js';
import { renderEdgeSiteBlock } from '../src/edge.js';
import { adaptersVolumeName, contentVolumeName } from '../src/naming.js';
import { render } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import type {
  assertAttributablePromotionDiff as AssertAttributablePromotionDiffFn,
  transform as TransformFn,
} from '../src/transform.js';
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
 * `backupEncryptionRecipient`/`mailIdentity`). The tier-differentiated
 * fields (`limits`/`mediaResize`/`mediaSrcsets`) are NOT invented here --
 * they are read straight off this repo's own pre-existing, unmodified
 * fixtures, so a future change to what "entry" or "professional" means
 * updates this test for free rather than silently drifting from it.
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
      mailIdentity: { domain: 'blog.entry-promotion.example.test', dkimSelector: 'bl' },
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
      mailIdentity: { domain: 'news.professional-promotion.example.test', dkimSelector: 'pro' },
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
      expect(tenant.mail).not.toEqual(demo.mail);
      expect(tenant.limits).not.toEqual(demo.limits);
      expect(tenant.expiresAt).not.toBe(demo.expiresAt);

      // The mail identity landed exactly as the target supplied it, kind
      // flipped to "tenant" by transform() itself -- never taken as
      // promotion input (the same pattern database.kind/media.kind follow).
      // Everything else in `mail` (whether it's enabled, both ceilings) is
      // NOT tier policy this transform invents: `validate()` on origin/main
      // fixes no tenant-tier value for either, so they survive from the
      // demo unchanged, same as `caps`.
      expect(tenant.mail.identity).toEqual({
        kind: 'tenant',
        domain: targets.mailIdentity.domain,
        dkimSelector: targets.mailIdentity.dkimSelector,
      });
      expect(tenant.mail.enabled).toBe(demo.mail.enabled);
      expect(tenant.mail.ceiling).toBe(demo.mail.ceiling);
      expect(tenant.mail.estateCeiling).toBe(demo.mail.estateCeiling);

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

      // ghost-settings.json (settings.ts): `codeinjection_head`/
      // `codeinjection_foot`/`codeInjectionExplainer` are a pure function of
      // `codeInjection` alone, which transform() never touches -- those
      // three stay byte-identical. `members_support_address` is sourced
      // from `mail.identity` (`settings.ts#renderSettings`), which IS
      // attributable now -- it must change alongside it.
      const demoSettings = JSON.parse(demoArtefacts.get('ghost-settings.json')!) as Record<
        string,
        unknown
      >;
      const tenantSettings = JSON.parse(tenantArtefacts.get('ghost-settings.json')!) as Record<
        string,
        unknown
      >;
      for (const field of ['codeinjection_head', 'codeinjection_foot', 'codeInjectionExplainer']) {
        expect(tenantSettings[field]).toEqual(demoSettings[field]);
      }
      expect(tenantSettings.members_support_address).not.toEqual(
        demoSettings.members_support_address
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

  it('refuses a promotion with no mail target, naming the field', () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);
    // `mailIdentity` is required by the type, so a runtime caller that
    // skips it (an untyped JS caller, or a value read from outside this
    // schema) is exercised here by constructing the omission deliberately.
    const { mailIdentity: _mailIdentity, ...withoutMailIdentity } =
      PROMOTION_TARGETS_BY_TIER.professional;
    expect(() => transform(demo, TEST_ZONES, withoutMailIdentity as PromotionTargets)).toThrow(
      /mailIdentity/
    );
  });
});

describe('CONTROL CASE — sabotage: real regressions the falsifying test must catch', () => {
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

  it('a transform() mutated to hardcode media.resize/srcsets ships the wrong tier; the real one respects the target', async () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);

    // RED: mutate transform.ts's real media block back to a hardcoded
    // `true`/`true` -- the professional tier's own media settings, shipped
    // to every promotion regardless of the target tier, entry included.
    const sabotaged = await importSabotaged<{ transform: typeof TransformFn }>(
      'transform.ts',
      (source) => {
        const target = 'resize: targets.mediaResize,\n      srcsets: targets.mediaSrcsets,';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in transform.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, 'resize: true,\n      srcsets: true,');
      }
    );
    const sabotagedTenant = sabotaged.transform(demo, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.entry);
    if (sabotagedTenant.media.kind !== 's3') throw new Error('expected s3 media');
    // The entry tier's own target says `resize: false` -- the sabotaged
    // module ships `true` anyway, exactly like the original defect.
    expect(sabotagedTenant.media.resize).toBe(true);
    expect(sabotagedTenant.media.resize).not.toBe(PROMOTION_TARGETS_BY_TIER.entry.mediaResize);

    // GREEN: the real, unmutated module ships the entry tier's own value.
    const realTenant = transform(demo, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.entry);
    if (realTenant.media.kind !== 's3') throw new Error('expected s3 media');
    expect(realTenant.media.resize).toBe(PROMOTION_TARGETS_BY_TIER.entry.mediaResize);
    expect(realTenant.media.resize).toBe(false);
  });

  it('a transform() mutated to drop the mail write leaves a promoted tenant carrying its demo mail identity; the falsifying test catches it', async () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);

    // RED: mutate transform.ts's real return object to drop the `mail`
    // write entirely -- the promoted descriptor then carries the demo's
    // own `mail.identity.kind: "demo"` forward unchanged, exactly the
    // defect the owner's ruling exists to close. Nothing in transform()
    // itself refuses this; `validate()`'s tier-vs-identity check
    // (`checkTierVariants`) is what the falsifying test relies on to
    // notice it.
    const sabotaged = await importSabotaged<{ transform: typeof TransformFn }>(
      'transform.ts',
      (source) => {
        const target =
          "    mail: {\n      ...demo.mail,\n      identity: {\n        kind: 'tenant',\n" +
          '        domain: targets.mailIdentity.domain,\n' +
          '        dkimSelector: targets.mailIdentity.dkimSelector,\n' +
          '      },\n    },\n    limits: targets.limits,';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in transform.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '    limits: targets.limits,');
      }
    );
    const sabotagedTenant = sabotaged.transform(
      demo,
      TEST_ZONES,
      PROMOTION_TARGETS_BY_TIER.professional
    );
    expect(sabotagedTenant.mail.identity).toEqual(demo.mail.identity);
    expect(() => validate(sabotagedTenant, TEST_ZONES)).toThrow(/mail\.identity\.kind/);

    // GREEN: the real, unmutated module writes the tenant's own mail
    // identity, and the promoted descriptor validates.
    const realTenant = transform(demo, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.professional);
    expect(realTenant.mail.identity).toEqual({
      kind: 'tenant',
      domain: PROMOTION_TARGETS_BY_TIER.professional.mailIdentity.domain,
      dkimSelector: PROMOTION_TARGETS_BY_TIER.professional.mailIdentity.dkimSelector,
    });
    expect(() => validate(realTenant, TEST_ZONES)).not.toThrow();
  });

  it('an edge.ts mutated to never admit a hostname hides the demo-to-tenant certificate transition; the real module flips it', async () => {
    const demo = validate(demoDescriptor(), TEST_ZONES);
    const tenant = transform(demo, TEST_ZONES, PROMOTION_TARGETS_BY_TIER.professional);

    // RED: mutate edge.ts's real `renderEdgeSiteBlock` so `admittedHostname`
    // is always `null` -- a promoted tenant that never becomes eligible for
    // an on-demand certificate, with nothing in the falsifying test
    // noticing unless this artefact is itself compared.
    const sabotaged = await importSabotaged<{
      renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn;
    }>('edge.ts', (source) => {
      const target = 'admittedHostname: servedHostnameOf(descriptor, zones),';
      if (!source.includes(target)) {
        throw new Error(
          'sabotage target string not found in edge.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(target, 'admittedHostname: null,');
    });
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(tenant, TEST_ZONES, uploadLimits());
    expect(sabotagedEdge.admittedHostname).toBeNull(); // wrong -- a promoted tenant, stuck null

    // GREEN: the real, unmutated module flips it on promotion.
    const realEdge = renderEdgeSiteBlock(tenant, TEST_ZONES, uploadLimits());
    expect(realEdge.admittedHostname).not.toBeNull();
  });
});
