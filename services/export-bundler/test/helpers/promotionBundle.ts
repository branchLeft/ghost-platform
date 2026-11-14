import { buildTar, type ArchiveFile } from '../../src/archive.js';
import type { ContentCounts } from '../../src/bundleReader.js';
import { parseCsv } from '../../src/bundleReader.js';
import type { DestinationMember, PromotionImportTarget } from '../../src/promotionImport.js';

export interface BundleOptions {
  readonly posts?: number;
  readonly pages?: number;
  readonly members?: readonly { email: string; tiers?: readonly string[] }[];
  /** Replaces or removes entries (a `null` removes) after the bundle is assembled. */
  readonly override?: Readonly<Record<string, string | Buffer | null>>;
  readonly manifestMembers?: Record<string, unknown>;
}

export const SOURCE_MEMBERS = [
  { email: 'member-one@example.test', tiers: ['TIER_SLUG_PAID'] },
  { email: 'member-two@example.test', tiers: [] },
  { email: 'member-three@example.test', tiers: ['TIER_SLUG_PAID'] },
] as const;

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function bundleFiles(options: BundleOptions = {}): ArchiveFile[] {
  const posts = options.posts ?? 4;
  const pages = options.pages ?? 2;
  const members = options.members ?? SOURCE_MEMBERS;
  const rows = [
    ...Array.from({ length: posts }, (_, i) => ({
      id: `p${i}`,
      type: 'post',
      title: `TITLE_${i}`,
    })),
    ...Array.from({ length: pages }, (_, i) => ({ id: `g${i}`, type: 'page', title: `PAGE_${i}` })),
  ];
  const memberRows = members.map((m, i) => ({
    id: `m${i}`,
    email: m.email,
    name: `NAME, "${i}"\nLINE`,
    tiers: (m.tiers ?? []).map((slug) => ({ slug })),
    subscriptions: [],
  }));
  const csv = [
    'id,email,name,note',
    ...memberRows.map((m) => [m.id, m.email, m.name, ''].map(csvField).join(',')),
  ].join('\n');
  const manifest = {
    complete: true,
    extensions: [
      {
        name: 'members_and_subscriptions',
        status: 'complete',
        expected: members.length,
        present: members.length,
        notes: [],
        info: [],
        ...options.manifestMembers,
      },
    ],
  };
  const entries: Record<string, string | Buffer | null> = {
    'content_and_settings.json': JSON.stringify({ db: [{ meta: {}, data: { posts: rows } }] }),
    'post_analytics.csv': 'post_id,visits\n',
    'members.json': JSON.stringify({ members: memberRows }),
    'members.csv': csv + '\n',
    'manifest.json': JSON.stringify(manifest),
    ...options.override,
  };
  return Object.entries(entries).flatMap(([name, data]) => (data === null ? [] : [{ name, data }]));
}

export function bundleTar(options: BundleOptions = {}): Buffer {
  return buildTar(bundleFiles(options), 1_700_000_000);
}

export interface FakeTargetOptions {
  readonly initial?: ContentCounts;
  /** Leaves the content import doing nothing, as a broken step would. */
  readonly dropContent?: boolean;
  readonly dropMembers?: boolean;
  readonly failContent?: boolean;
  readonly failCount?: boolean;
  /** Members arrive without their tiers, as Ghost's CSV import may. */
  readonly loseTiers?: boolean;
  /** The destination's tier assignment by email, for members it already holds. */
  readonly sourceTiers?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A stand-in for the destination Ghost that does what Ghost's two imports do
 * to its row counts: the content import adds the file's posts and pages, the
 * members import adds one member per CSV record.
 */
export class FakeTarget implements PromotionImportTarget {
  posts: number;
  pages: number;
  readonly members = new Map<string, string[]>();
  readonly calls: string[] = [];

  constructor(private readonly options: FakeTargetOptions = {}) {
    this.posts = options.initial?.posts ?? 1;
    this.pages = options.initial?.pages ?? 0;
    for (let i = 0; i < (options.initial?.members ?? 0); i += 1) {
      this.members.set(`existing-${i}@example.test`, []);
    }
  }

  count(): Promise<ContentCounts> {
    this.calls.push('count');
    if (this.options.failCount) return Promise.reject(new Error('count refused'));
    return Promise.resolve({ posts: this.posts, pages: this.pages, members: this.members.size });
  }

  importContent(bytes: Buffer): Promise<void> {
    this.calls.push('importContent');
    if (this.options.failContent) return Promise.reject(new Error('import answered 500'));
    if (this.options.dropContent) return Promise.resolve();
    const rows = (
      JSON.parse(bytes.toString('utf8')) as { db: { data: { posts: { type: string }[] } }[] }
    ).db[0]!.data.posts;
    this.pages += rows.filter((r) => r.type === 'page').length;
    this.posts += rows.filter((r) => r.type !== 'page').length;
    return Promise.resolve();
  }

  importMembersCsv(bytes: Buffer): Promise<void> {
    this.calls.push('importMembersCsv');
    if (this.options.dropMembers) return Promise.resolve();
    const [header, ...records] = parseCsv(bytes.toString('utf8'));
    const column = header!.indexOf('email');
    for (const record of records) {
      const email = record[column]!.toLowerCase();
      this.members.set(
        email,
        this.options.loseTiers ? [] : [...(this.options.sourceTiers?.[email] ?? [])]
      );
    }
    return Promise.resolve();
  }

  listMembers(): Promise<readonly DestinationMember[]> {
    this.calls.push('listMembers');
    return Promise.resolve([...this.members].map(([email, tierSlugs]) => ({ email, tierSlugs })));
  }
}

export const SOURCE_TIERS: Readonly<Record<string, readonly string[]>> = {
  'member-one@example.test': ['TIER_SLUG_PAID'],
  'member-three@example.test': ['TIER_SLUG_PAID'],
};
