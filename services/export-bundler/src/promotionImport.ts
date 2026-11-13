import { openBundle, readTar, type ContentCounts, type ExportBundle } from './bundleReader.js';

/**
 * The import half of a promotion: an export bundle's posts, pages and members
 * go into a freshly provisioned tenant through Ghost's own import, and the
 * tenant is counted before and after. Every effect is injected, so nothing
 * here knows about a network, a key or a host. The promotion is complete only
 * when `runPromotionImport` returns; a throw means the tenant is not verified
 * and must not be marked live. The demo is only ever read.
 */

export interface DestinationMember {
  readonly email: string;
  readonly tierSlugs: readonly string[];
}

/** Ghost's own admin routes on the destination tenant, behind one narrow door. */
export interface PromotionImportTarget {
  /** Counts of what the tenant holds now: posts, pages and members, drafts included. */
  count(): Promise<ContentCounts>;
  /** Ghost's "Content & settings" import (`POST /ghost/api/admin/db/`). */
  importContent(bytes: Buffer): Promise<void>;
  /** Ghost's members CSV import (`POST /ghost/api/admin/members/upload/`). */
  importMembersCsv(bytes: Buffer): Promise<void>;
  /** Every member the tenant holds, with the slugs of the tiers each is on. */
  listMembers(): Promise<readonly DestinationMember[]>;
}

export interface PromotionImportDeps {
  /** The bundle's plaintext tar, opened with the tenant's own key by the caller. */
  readonly openArchive: () => Promise<Buffer>;
  readonly target: PromotionImportTarget;
}

export interface PromotionImportResult {
  readonly before: ContentCounts;
  /** What the bundle holds. */
  readonly bundle: ContentCounts;
  readonly after: ContentCounts;
  /** Members on a tier at the source, every one of whom was found on that tier at the destination. */
  readonly tierMembersVerified: number;
}

/** The destination already holds members, so before-and-after counts would not mean what they say. */
export class DestinationNotFreshError extends Error {
  constructor(readonly members: number) {
    super(
      `the destination already holds ${members} members; a promotion imports into an empty tenant`
    );
    this.name = 'DestinationNotFreshError';
  }
}

/** One of Ghost's imports failed or the destination could not be read; the tenant is not verified. */
export class ImportStepError extends Error {
  constructor(
    readonly step:
      'count-before' | 'import-content' | 'import-members' | 'count-after' | 'list-members',
    cause: unknown
  ) {
    super(
      `promotion import failed at ${step}: ${cause instanceof Error ? cause.name : 'unknown failure'}`,
      { cause }
    );
    this.name = 'ImportStepError';
  }
}

/**
 * The imports ran but the tenant does not hold what the bundle held. Names
 * the figures and never a member's address.
 */
export class ImportVerificationError extends Error {
  constructor(
    readonly mismatches: readonly string[],
    readonly before: ContentCounts,
    readonly expected: ContentCounts,
    readonly after: ContentCounts
  ) {
    super(`promotion import did not verify: ${mismatches.join('; ')}`);
    this.name = 'ImportVerificationError';
  }
}

async function step<T>(name: ImportStepError['step'], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new ImportStepError(name, err);
  }
}

const FIELDS = ['posts', 'pages', 'members'] as const;

function countMismatches(expected: ContentCounts, after: ContentCounts): string[] {
  return FIELDS.flatMap((field) =>
    after[field] === expected[field]
      ? []
      : [`${field}: expected ${expected[field]} after import, found ${after[field]}`]
  );
}

function tierMismatches(bundle: ExportBundle, destination: readonly DestinationMember[]): string[] {
  const held = new Map(
    destination.map((m) => [m.email.trim().toLowerCase(), new Set(m.tierSlugs)])
  );
  const lost = bundle.memberTiers.filter((m) => {
    const slugs = held.get(m.email);
    return slugs === undefined || m.tierSlugs.some((slug) => !slugs.has(slug));
  });
  return lost.length === 0
    ? []
    : [
        `${lost.length} of ${bundle.memberTiers.length} members on a tier are not on it after import`,
      ];
}

/**
 * Opens the bundle (refusing one that does not agree with itself, before
 * anything is copied), requires an empty member table at the destination,
 * imports content then members through Ghost, and counts again. The tenant
 * must hold exactly what it held before plus what the bundle carried, and
 * every member who was on a tier must still be on it: the tier gap in Ghost's
 * export and import is checked here, not assumed.
 */
export async function runPromotionImport(
  deps: PromotionImportDeps
): Promise<PromotionImportResult> {
  const bundle = openBundle(readTar(await deps.openArchive()));
  const before = await step('count-before', () => deps.target.count());
  if (before.members !== 0) throw new DestinationNotFreshError(before.members);

  await step('import-content', () => deps.target.importContent(bundle.contentJson));
  await step('import-members', () => deps.target.importMembersCsv(bundle.membersCsv));

  const expected: ContentCounts = {
    posts: before.posts + bundle.counts.posts,
    pages: before.pages + bundle.counts.pages,
    members: before.members + bundle.counts.members,
  };
  const after = await step('count-after', () => deps.target.count());
  const mismatches = countMismatches(expected, after);
  if (mismatches.length === 0 && bundle.memberTiers.length > 0) {
    const destination = await step('list-members', () => deps.target.listMembers());
    mismatches.push(...tierMismatches(bundle, destination));
  }
  if (mismatches.length > 0) throw new ImportVerificationError(mismatches, before, expected, after);
  return { before, bundle: bundle.counts, after, tierMembersVerified: bundle.memberTiers.length };
}
