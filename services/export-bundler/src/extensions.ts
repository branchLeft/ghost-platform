import type { ArchiveFile } from './archive.js';
import type { Collection, ExportFile, GhostExportClient } from './ghostExportClient.js';
import { planMedia, scanMediaReferences, type MediaProbe } from './mediaManifest.js';
import type { MediaLinkSigner } from './mediaLinks.js';

/**
 * The three gaps the first bundler only named: media, members and their
 * subscriptions, and comments with their moderation state. Each is fetched
 * and then checked against an authoritative count, so an extension is
 * `complete` only when what the archive carries is what the source says
 * exists. A fetch that fails or falls short is reported as `failed` or
 * `partial`, and the manifest says so; it never claims completeness over a
 * short archive.
 */

export type ExtensionName = 'media' | 'members_and_subscriptions' | 'comments';
export type ExtensionStatus = 'complete' | 'partial' | 'failed';

export interface ExtensionReport {
  readonly name: ExtensionName;
  readonly status: ExtensionStatus;
  /** What the source says exists; `null` when the source could not be asked. */
  readonly expected: number | null;
  /** What the archive actually carries. */
  readonly present: number;
  /** Why it is not complete; empty when it is. */
  readonly notes: readonly string[];
  /** Facts about what was included, which say nothing about completeness. */
  readonly info: readonly string[];
}

export interface ExtensionOutcome {
  readonly report: ExtensionReport;
  readonly files: readonly ArchiveFile[];
}

export interface MediaConfig {
  /** The base URL the tenant's own rendered environment serves media from; `null` when it has none. */
  readonly baseUrl: string | null;
  readonly signer: MediaLinkSigner;
}

export interface ExtensionDeps {
  readonly client: GhostExportClient;
  readonly mediaProbe: MediaProbe;
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly media: MediaConfig;
  readonly nowSeconds: number;
  readonly contentJson: string;
}

export const MEMBERS_ENTRY = 'members.json';
export const MEMBERS_CSV_ENTRY = 'members.csv';
export const COMMENTS_ENTRY = 'comments.json';
export const MEDIA_LINKS_ENTRY = 'media_links.json';

export const COMMENT_STATUSES: readonly string[] = ['published', 'hidden', 'deleted'];

type Row = Record<string, unknown>;

/**
 * The manifest sits beside the archive in the clear, so a failure is named
 * by its kind and route only, never by a message that could echo Ghost's
 * response body, which can hold a member's data.
 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown failure';
  const { route, status } = err as { route?: unknown; status?: unknown };
  return typeof route === 'string' && typeof status === 'number'
    ? `${err.name} on ${route.split('?')[0]} (${status})`
    : err.name;
}

function failure(name: ExtensionName, err: unknown): ExtensionOutcome {
  return {
    report: {
      name,
      status: 'failed',
      expected: null,
      present: 0,
      notes: [describe(err)],
      info: [],
    },
    files: [],
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Counts distinct, non-empty ids; every other row is one the archive cannot vouch for. */
function distinctIds(items: readonly Row[]): { distinct: number; unidentified: number } {
  const seen = new Set<string>();
  let unidentified = 0;
  for (const row of items) {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) unidentified += 1;
    else seen.add(id);
  }
  return { distinct: seen.size, unidentified };
}

function statusFor(notes: readonly string[]): ExtensionStatus {
  return notes.length === 0 ? 'complete' : 'partial';
}

export async function collectMembers(deps: ExtensionDeps): Promise<ExtensionOutcome> {
  let members: Collection;
  let csv: ExportFile;
  try {
    members = await deps.client.fetchMembers(deps.baseUrl);
    csv = await deps.client.fetchMembersCsv(deps.baseUrl);
  } catch (err) {
    return failure('members_and_subscriptions', err);
  }
  const notes: string[] = [];
  const { distinct, unidentified } = distinctIds(members.items);
  if (members.items.length !== members.total) {
    notes.push(`read ${members.items.length} members, Ghost counts ${members.total}`);
  }
  if (unidentified > 0) notes.push(`${unidentified} member rows have a missing or repeated id`);
  const withoutSubscriptions = members.items.filter((m) => !Array.isArray(m.subscriptions)).length;
  if (withoutSubscriptions > 0) {
    notes.push(`${withoutSubscriptions} member rows carry no subscription list`);
  }
  const subscriptions = members.items.reduce(
    (n, m) => n + (Array.isArray(m.subscriptions) ? m.subscriptions.length : 0),
    0
  );
  return {
    report: {
      name: 'members_and_subscriptions',
      status: statusFor(notes),
      expected: members.total,
      present: distinct,
      notes,
      info: [`${subscriptions} subscription records included`],
    },
    files: [
      { name: MEMBERS_ENTRY, data: json({ members: members.items }) },
      { name: MEMBERS_CSV_ENTRY, data: csv.body },
    ],
  };
}

function reportCountOf(comment: Row): number {
  const count = comment.count;
  if (typeof count === 'object' && count !== null) {
    const reports = (count as Row).reports;
    if (typeof reports === 'number' && reports > 0) return reports;
  }
  return 0;
}

export async function collectComments(deps: ExtensionDeps): Promise<ExtensionOutcome> {
  let comments: Collection;
  try {
    comments = await deps.client.fetchComments(deps.baseUrl);
  } catch (err) {
    return failure('comments', err);
  }
  const notes: string[] = [];
  const { distinct, unidentified } = distinctIds(comments.items);
  if (comments.items.length !== comments.total) {
    notes.push(`read ${comments.items.length} comments, Ghost counts ${comments.total}`);
  }
  if (unidentified > 0) notes.push(`${unidentified} comment rows have a missing or repeated id`);

  const exported: Row[] = [];
  let unreadable = 0;
  let reportsMissing = 0;
  for (const comment of comments.items) {
    const status = comment.status;
    const stateKnown = typeof status === 'string' && COMMENT_STATUSES.includes(status);
    if (!stateKnown) unreadable += 1;
    const expectedReports = reportCountOf(comment);
    let reports: readonly Row[] = [];
    let reportsRead = true;
    if (expectedReports > 0 && typeof comment.id === 'string') {
      try {
        const read = await deps.client.fetchCommentReports(deps.baseUrl, comment.id);
        reports = read.items;
        reportsRead = read.items.length === read.total && read.total === expectedReports;
      } catch {
        reportsRead = false;
      }
      if (!reportsRead) reportsMissing += 1;
    }
    exported.push({
      ...comment,
      moderation: {
        status: stateKnown ? status : null,
        reportCount: expectedReports,
        reports,
        reportsComplete: reportsRead,
      },
    });
  }
  if (unreadable > 0) notes.push(`${unreadable} comments have no readable moderation status`);
  if (reportsMissing > 0)
    notes.push(`${reportsMissing} comments have reports that could not be read in full`);

  const byStatus = COMMENT_STATUSES.map(
    (s) => `${exported.filter((c) => (c.moderation as Row).status === s).length} ${s}`
  ).join(', ');
  return {
    report: {
      name: 'comments',
      status: statusFor(notes),
      expected: comments.total,
      present: distinct,
      notes,
      info: [`moderation states: ${byStatus}`],
    },
    files: [{ name: COMMENTS_ENTRY, data: json({ comments: exported }) }],
  };
}

export async function collectMedia(deps: ExtensionDeps): Promise<ExtensionOutcome> {
  if (deps.media.baseUrl === null) {
    return failure(
      'media',
      new Error("the tenant's rendered environment names no object-storage media address")
    );
  }
  try {
    const scan = scanMediaReferences(deps.contentJson, deps.media.baseUrl);
    const plan = await planMedia(
      scan,
      deps.media.baseUrl,
      deps.mediaProbe,
      deps.media.signer,
      deps.tenantId,
      deps.nowSeconds
    );
    const notes: string[] = [];
    if (plan.missing.length > 0) {
      notes.push(`${plan.missing.length} referenced objects are not in storage`);
    }
    if (plan.unverified.length > 0) {
      notes.push(`${plan.unverified.length} referenced objects could not be checked`);
    }
    const expiry = plan.links.reduce((min, l) => Math.min(min, l.expiresAt), Infinity);
    return {
      report: {
        name: 'media',
        status: statusFor(notes),
        expected: scan.keys.length,
        present: plan.links.length,
        notes,
        info: [
          `${plan.refused.length} references under another prefix were refused and not linked`,
          'links only: the archive carries no media bytes, and the links expire',
        ],
      },
      files: [
        {
          name: MEDIA_LINKS_ENTRY,
          data: json({
            tenantId: deps.tenantId,
            ttlSeconds: deps.media.signer.ttlSeconds,
            earliestExpiry: Number.isFinite(expiry) ? new Date(expiry * 1000).toISOString() : null,
            links: plan.links,
            missing: plan.missing,
            unverified: plan.unverified,
            refused: plan.refused,
          }),
        },
      ],
    };
  } catch (err) {
    return failure('media', err);
  }
}

/** Runs all three; one failing never stops the others. */
export async function collectExtensions(deps: ExtensionDeps): Promise<readonly ExtensionOutcome[]> {
  return [await collectMedia(deps), await collectMembers(deps), await collectComments(deps)];
}
