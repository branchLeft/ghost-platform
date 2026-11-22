/**
 * The rewrite half of a promotion: a demo's content export, before Ghost's own
 * import, with its links pointed at the tenant's media address, its staff
 * removed and the settings the tenant owns left to the tenant. Pure: it takes
 * the parsed export and returns a new one; nothing here reads a file, a
 * network or a key. The rules follow the probe's rewrite_export in
 * adapters/scanning-storage/probe/probe_model.py, so the two agree.
 */

type Json = Record<string, unknown>;

/** The demo's path under /content/ (exact text, e.g. `images/2026/11/my photo (1).JPG`) to the URL the upload step answered. */
export type UploadMap = ReadonlyMap<string, string>;

export const DEMO_HOST = 'demo.ghost.test';
export const PLACEHOLDER = '__GHOST_URL__';

/** Every spelling of the demo's own origin, longest first where they overlap. */
const HOST_FORMS = [
  `https://${DEMO_HOST}:2368`,
  `http://${DEMO_HOST}:2368`,
  `https://${DEMO_HOST}`,
  `http://${DEMO_HOST}`,
] as const;

/** The site-relative placeholder and the demo's origin, each followed by the content path. */
const CONTENT_PREFIXES = [PLACEHOLDER, ...HOST_FORMS].map((origin) => `${origin}/content/`);

/** Settings the tenant owns: dropped from the export so Ghost keeps the tenant's own values. */
export const TENANT_OWNED_SETTINGS = [
  'accent_color',
  'active_theme',
  'codeinjection_foot',
  'codeinjection_head',
  'locale',
  'timezone',
] as const;

/** Settings whose value holds an image or a link that can point at the demo. */
const SETTING_LINK_KEYS = [
  'logo',
  'icon',
  'cover_image',
  'og_image',
  'twitter_image',
  'navigation',
] as const;

export interface RewrittenColumn {
  readonly table: string;
  readonly column: string;
  /** For a settings table: only the rows with these keys. */
  readonly keys?: readonly string[];
}

/** Every field class that can hold a link to an uploaded file or to the demo's origin. */
export const REWRITTEN_COLUMNS: readonly RewrittenColumn[] = [
  { table: 'posts', column: 'lexical' },
  { table: 'posts', column: 'html' },
  { table: 'posts', column: 'feature_image' },
  { table: 'posts_meta', column: 'og_image' },
  { table: 'posts_meta', column: 'twitter_image' },
  { table: 'tags', column: 'feature_image' },
  { table: 'tags', column: 'og_image' },
  { table: 'tags', column: 'twitter_image' },
  { table: 'newsletters', column: 'header_image' },
  { table: 'settings', column: 'value', keys: SETTING_LINK_KEYS },
];

/** A content path left unanswered: the placeholder form, up to a quote, angle bracket or backslash. */
const UNANSWERED = /__GHOST_URL__\/content\/[^"'<>\\]*/g;

export interface RewriteOptions {
  readonly uploads: UploadMap;
  /** The tenant's owner: every post's author after the rewrite. */
  readonly ownerId: string;
  /** Control only: `table.column` names left exactly as the demo has them. */
  readonly leaveOut?: readonly string[];
}

export interface RewriteResult {
  readonly export: Json;
  /** Content paths the upload did not answer, by reference, left as they are. */
  readonly unanswered: readonly string[];
}

/** The input is not a Ghost content export of the shape this rewrite reads. */
export class ExportShapeError extends Error {
  constructor(detail: string) {
    super(`not a Ghost content export: ${detail}`);
    this.name = 'ExportShapeError';
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(root: Json): Json {
  const first = Array.isArray(root.db) ? (root.db[0] as unknown) : undefined;
  if (!isRecord(first)) throw new ExportShapeError('db[0] is missing');
  const data = first.data;
  if (!isRecord(data)) throw new ExportShapeError('db[0].data is missing');
  return data;
}

function rowsOf(data: Json, table: string): Json[] {
  const raw = data[table];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function includesKey(keys: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && keys.includes(value);
}

/** Percent-encoding that also escapes the characters encodeURIComponent leaves alone. */
function strictEncode(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Every spelling an upload's path can take in the demo's export: raw, and percent-encoded two ways. */
function spellings(path: string): string[] {
  const segments = path.split('/');
  return [
    ...new Set([
      path,
      segments.map((s) => encodeURIComponent(s)).join('/'),
      segments.map(strictEncode).join('/'),
    ]),
  ];
}

type Pair = readonly [from: string, to: string];

function longestFirst(pairs: Pair[]): Pair[] {
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function uploadPairs(uploads: UploadMap): Pair[] {
  const pairs: Pair[] = [];
  for (const [path, url] of uploads) {
    for (const spelling of spellings(path)) {
      for (const prefix of CONTENT_PREFIXES) pairs.push([prefix + spelling, url]);
    }
  }
  return longestFirst(pairs);
}

/** Exact text replacement, one pair at a time, never a pattern. */
function replaceExact(text: string, pairs: readonly Pair[]): string {
  return pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
}

/**
 * The demo's export, rewritten for a JSON import into the tenant. Every demo
 * spelling of an uploaded file's content path becomes the URL the tenant
 * answered for it; the demo's origin, in any spelling, becomes the placeholder;
 * the demo's users and their role rows go; every post's creator and author is
 * the tenant's owner, one author per post; the settings the tenant owns are
 * dropped. The input is not changed.
 */
export function rewriteExport(exported: unknown, options: RewriteOptions): RewriteResult {
  if (options.ownerId.trim() === '') throw new TypeError('the tenant owner id is empty');
  if (!isRecord(exported)) throw new ExportShapeError('the root is not an object');
  const root = structuredClone(exported);
  const data = dataOf(root);

  const removed = new Set<unknown>(rowsOf(data, 'users').map((u) => u.id));
  delete data.users;
  for (const table of ['roles_users', 'permissions_users']) {
    if (Array.isArray(data[table])) {
      data[table] = rowsOf(data, table).filter((r) => !removed.has(r.user_id));
    }
  }

  for (const post of rowsOf(data, 'posts')) {
    for (const column of ['created_by', 'updated_by']) {
      if (removed.has(post[column])) post[column] = options.ownerId;
    }
  }
  if (Array.isArray(data.posts_authors)) {
    const seenPosts = new Set<unknown>();
    data.posts_authors = rowsOf(data, 'posts_authors').flatMap((link) => {
      if (seenPosts.has(link.post_id)) return [];
      seenPosts.add(link.post_id);
      return [{ ...link, author_id: options.ownerId }];
    });
  }

  if (Array.isArray(data.settings)) {
    data.settings = rowsOf(data, 'settings').filter(
      (r) => !includesKey(TENANT_OWNED_SETTINGS, r.key)
    );
  }

  const uploads = uploadPairs(options.uploads);
  const hosts = longestFirst(HOST_FORMS.map((form) => [form, PLACEHOLDER] as const).slice());
  const leftOut = new Set(options.leaveOut ?? []);
  const unanswered = new Set<string>();
  for (const { table, column, keys } of REWRITTEN_COLUMNS) {
    if (leftOut.has(`${table}.${column}`)) continue;
    for (const row of rowsOf(data, table)) {
      if (keys !== undefined && !includesKey(keys, row.key)) continue;
      const value = row[column];
      if (typeof value !== 'string') continue;
      const rewritten = replaceExact(replaceExact(value, uploads), hosts);
      row[column] = rewritten;
      for (const match of rewritten.matchAll(UNANSWERED)) unanswered.add(match[0].trimEnd());
    }
  }

  return { export: root, unanswered: [...unanswered].sort() };
}
