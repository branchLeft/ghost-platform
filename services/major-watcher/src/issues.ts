// Files the tracked item for a new Ghost major in the workspace repository,
// mechanically: plain REST calls, no model, no agent, no Desk card.
//
// Idempotent per major. The key is a marker line carrying the major version
// (see `majorMarker`) in the item's body. Before creating anything the filer
// searches the workspace issues that carry the `upstream-major` label, open
// and closed alike, for that marker; a run that finds it files nothing and
// only makes sure the item sits under the launch item. A run that dies
// between the create and the attach is therefore repaired by the next run,
// and a re-run after a failed page can never produce a second item.
//
// The credential is the filing identity's own token, read from the
// environment and never from the ambient Actions token, which is scoped to
// this repository and cannot write the workspace. The recommended identity is
// a GitHub App installation token with `issues: write` on the workspace
// repository only (README.md "Filing credential"). With no token, or no
// launch item, nothing is attempted and the call throws: it fails closed.

import { resolveTimeoutMs, rethrowOrTimeout } from './timeout.js';
import type { UpstreamMajorItem } from './filing.js';

export type FetchLike = typeof fetch;

export const WORKSPACE_REPO = 'branchLeft/workspace';
export const UPSTREAM_MAJOR_LABEL = 'upstream-major';
// Labels the item carries besides the one that is its identity.
export const ITEM_LABELS: readonly string[] = [
  UPSTREAM_MAJOR_LABEL,
  'type:platform-story',
  'repo:ghost-platform',
];

const API_ROOT = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 30000;
const PER_PAGE = 100;
// 1000 labelled issues is far beyond one per Ghost major line.
const MAX_PAGES = 10;

export interface FilingConfig {
  /** The filing identity's token. */
  readonly token: string;
  /** Issue number in the workspace repository the item is added to as a sub-issue. */
  readonly launchItem: number;
  /** Per-request limit in whole milliseconds; otherwise the default of 30000. */
  readonly timeoutMs?: number;
}

export interface FiledItem {
  readonly number: number;
  readonly url: string;
  /** False when the item for this major already existed and nothing was created. */
  readonly created: boolean;
}

/** The idempotence key: one line in the body, exact to the major. */
export function majorMarker(major: number): string {
  return `<!-- upstream-major:${major} -->`;
}

/**
 * Reads the filing configuration from the environment. Throws, naming the
 * variable, when either value is absent or unusable: no default, no fallback
 * to another token.
 */
export function readFilingConfig(
  env: Readonly<Record<string, string | undefined>>,
  names: { readonly token: string; readonly launchItem: string }
): FilingConfig {
  const token = env[names.token];
  if (!token) {
    throw new Error(
      `${names.token} is not set: the filing credential is not placed, so no tracked item can be filed`
    );
  }
  const raw = env[names.launchItem] ?? '';
  const launchItem = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(launchItem) || launchItem < 1) {
    throw new Error(
      `${names.launchItem} is not set to an issue number: got ${JSON.stringify(raw)}`
    );
  }
  return { token, launchItem };
}

interface IssueRecord {
  readonly id: number;
  readonly number: number;
  readonly html_url: string;
  readonly body?: string | null;
  readonly parent_issue_url?: string | null;
  readonly pull_request?: unknown;
}

async function call(
  config: FilingConfig,
  fetchImpl: FetchLike,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<unknown> {
  const limitMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.timeout(limitMs);
  const timeoutMessage = `GitHub ${method} ${path.split('?')[0]} timed out after ${limitMs} ms`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetchImpl(`${API_ROOT}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    rethrowOrTimeout(signal, timeoutMessage, error);
  }
  // Only the status goes into the message: never a response body, never a header.
  if (!res.ok) {
    throw new Error(
      `GitHub ${method} ${path.split('?')[0]} failed: ${res.status} ${res.statusText}`
    );
  }
  try {
    return await res.json();
  } catch (error) {
    rethrowOrTimeout(signal, timeoutMessage, error);
  }
}

async function findExisting(
  config: FilingConfig,
  fetchImpl: FetchLike,
  major: number
): Promise<IssueRecord | undefined> {
  const marker = majorMarker(major);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await call(
      config,
      fetchImpl,
      'GET',
      `/repos/${WORKSPACE_REPO}/issues?labels=${UPSTREAM_MAJOR_LABEL}&state=all&per_page=${PER_PAGE}&page=${page}`
    );
    if (!Array.isArray(result)) {
      throw new Error('GitHub issues response was not an array');
    }
    const issues = result as IssueRecord[];
    const hit = issues.find((issue) => !issue.pull_request && (issue.body ?? '').includes(marker));
    if (hit) return hit;
    if (issues.length < PER_PAGE) return undefined;
  }
  return undefined;
}

async function attach(config: FilingConfig, fetchImpl: FetchLike, issueId: number): Promise<void> {
  await call(
    config,
    fetchImpl,
    'POST',
    `/repos/${WORKSPACE_REPO}/issues/${config.launchItem}/sub_issues`,
    { sub_issue_id: issueId }
  );
}

/**
 * Files the tracked item for `item.major` unless one is already there, and
 * makes sure it sits under the launch item. Safe to call again and again.
 */
export async function fileUpstreamMajor(
  config: FilingConfig,
  item: UpstreamMajorItem,
  fetchImpl: FetchLike = fetch
): Promise<FiledItem> {
  const existing = await findExisting(config, fetchImpl, item.major);
  if (existing) {
    if (!existing.parent_issue_url) await attach(config, fetchImpl, existing.id);
    return { number: existing.number, url: existing.html_url, created: false };
  }

  const created = (await call(config, fetchImpl, 'POST', `/repos/${WORKSPACE_REPO}/issues`, {
    title: item.title,
    body: item.body,
    labels: ITEM_LABELS,
  })) as IssueRecord;
  await attach(config, fetchImpl, created.id);
  return { number: created.number, url: created.html_url, created: true };
}
