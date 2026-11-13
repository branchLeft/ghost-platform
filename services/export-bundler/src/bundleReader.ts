import type { ArchiveFile } from './archive.js';
import { MEMBERS_CSV_ENTRY, MEMBERS_ENTRY } from './extensions.js';

/**
 * The read side of `archive.ts`: the plaintext tar an export produced, after
 * the tenant's own key has opened it, read back into its named entries and
 * checked before anything is imported from it. Nothing here touches disk,
 * a key or a network.
 */

export class BundleReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleReadError';
  }
}

/** The bundle cannot be imported as it stands; nothing has been copied. */
export class BundleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleRefusedError';
  }
}

export const CONTENT_ENTRY = 'content_and_settings.json';
export const MANIFEST_ENTRY = 'manifest.json';

const BLOCK = 512;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function cString(buffer: Buffer, offset: number, width: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.toString(
    'ascii',
    offset,
    end === -1 || end > offset + width ? offset + width : end
  );
}

function octal(header: Buffer, offset: number, width: number, what: string): number {
  const text = cString(header, offset, width).trim();
  if (!/^[0-7]+$/.test(text)) throw new BundleReadError(`tar header has no readable ${what}`);
  return Number.parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === stored;
}

/**
 * Reads exactly what `buildTar` writes: plain ustar, regular files, short
 * names from the safe set. Anything else is refused rather than skipped, so a
 * crafted or damaged archive cannot hide an entry or reach outside the bundle.
 */
export function readTar(tar: Buffer): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > tar.length) throw new BundleReadError('tar ends before its terminator');
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) {
      if (offset + BLOCK > tar.length || !isZeroBlock(tar.subarray(offset, offset + BLOCK))) {
        throw new BundleReadError('tar terminator is incomplete');
      }
      return files;
    }
    if (!checksumOk(header)) throw new BundleReadError('tar header checksum does not match');
    const name = cString(header, 0, 100);
    if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
      throw new BundleReadError(`unsafe tar entry name: ${JSON.stringify(name)}`);
    }
    if (cString(header, 345, 155) !== '') {
      throw new BundleReadError(`tar entry ${name} uses a path prefix`);
    }
    const kind = String.fromCharCode(header[156]!);
    if (kind !== '0' && kind !== '\0') {
      throw new BundleReadError(`tar entry ${name} is not a regular file`);
    }
    if (seen.has(name)) throw new BundleReadError(`duplicate tar entry: ${name}`);
    seen.add(name);
    const size = octal(header, 124, 12, 'size');
    if (offset + size > tar.length) throw new BundleReadError(`tar entry ${name} is truncated`);
    files.push({ name, data: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let touched = false;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    touched = true;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r' && text[i + 1] === '\n') continue;
    else field += ch;
  }
  if (quoted) throw new BundleReadError('members.csv ends inside a quoted field');
  if (touched) endRow();
  return rows;
}

export interface ContentCounts {
  readonly posts: number;
  readonly pages: number;
  readonly members: number;
}

/** A member the source holds on at least one tier; the import must leave them on it. */
export interface ExpectedMemberTiers {
  readonly sourceId: string;
  readonly email: string;
  readonly tierSlugs: readonly string[];
}

/** An export bundle that has passed every check made before the import starts. */
export interface ExportBundle {
  readonly contentJson: Buffer;
  readonly membersCsv: Buffer;
  /** What the bundle itself holds: the figures the destination is checked against. */
  readonly counts: ContentCounts;
  readonly memberTiers: readonly ExpectedMemberTiers[];
}

type Row = Record<string, unknown>;

function entry(files: readonly ArchiveFile[], name: string): Buffer {
  const found = files.find((f) => f.name === name);
  if (found === undefined) throw new BundleRefusedError(`the bundle has no ${name}`);
  return typeof found.data === 'string' ? Buffer.from(found.data, 'utf8') : found.data;
}

function parseJson(buffer: Buffer, name: string): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new BundleRefusedError(`${name} is not JSON`);
  }
}

function contentRows(contentJson: Buffer): { posts: number; pages: number } {
  const parsed = parseJson(contentJson, CONTENT_ENTRY) as { db?: { data?: { posts?: unknown } }[] };
  const rows = parsed?.db?.[0]?.data?.posts;
  if (!Array.isArray(rows)) throw new BundleRefusedError(`${CONTENT_ENTRY} holds no posts list`);
  let pages = 0;
  for (const row of rows as Row[]) if (row.type === 'page') pages += 1;
  return { posts: rows.length - pages, pages };
}

function memberRows(membersJson: Buffer): Row[] {
  const parsed = parseJson(membersJson, MEMBERS_ENTRY) as { members?: unknown };
  if (!Array.isArray(parsed?.members)) {
    throw new BundleRefusedError(`${MEMBERS_ENTRY} holds no members list`);
  }
  return parsed.members as Row[];
}

function emailOf(row: Row): string {
  return typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
}

function csvEmails(csv: Buffer): string[] {
  let rows: string[][];
  try {
    rows = parseCsv(csv.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch (err) {
    throw new BundleRefusedError(err instanceof Error ? err.message : 'members.csv is unreadable');
  }
  const [header, ...records] = rows;
  const column = header?.map((h) => h.trim().toLowerCase()).indexOf('email') ?? -1;
  if (column === -1) throw new BundleRefusedError(`${MEMBERS_CSV_ENTRY} has no email column`);
  return records.map((r) => (r[column] ?? '').trim().toLowerCase());
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((x) => left.has(x));
}

function tierSlugsOf(row: Row): string[] {
  if (!Array.isArray(row.tiers)) return [];
  return (row.tiers as Row[]).flatMap((t) => (typeof t.slug === 'string' ? [t.slug] : []));
}

/**
 * Takes the bundle's entries and works out what it holds, refusing a bundle
 * that does not agree with itself: the members the import will copy (the CSV)
 * must be the members the export read (members.json), and the manifest must
 * say members were read in full. Comments and media are other stories and do
 * not make a bundle unimportable. Refusal happens before anything is copied.
 */
export function openBundle(files: readonly ArchiveFile[]): ExportBundle {
  const contentJson = entry(files, CONTENT_ENTRY);
  const membersCsv = entry(files, MEMBERS_CSV_ENTRY);
  const members = memberRows(entry(files, MEMBERS_ENTRY));
  const manifest = parseJson(entry(files, MANIFEST_ENTRY), MANIFEST_ENTRY) as {
    extensions?: { name?: unknown; status?: unknown; expected?: unknown; present?: unknown }[];
  };
  const report = manifest?.extensions?.find((e) => e.name === 'members_and_subscriptions');
  if (
    report === undefined ||
    report.status !== 'complete' ||
    report.expected !== members.length ||
    report.present !== members.length
  ) {
    throw new BundleRefusedError(
      'the manifest does not say members were read in full and matching the members list'
    );
  }
  const jsonEmails = members.map(emailOf);
  if (jsonEmails.some((e) => e === '') || new Set(jsonEmails).size !== jsonEmails.length) {
    throw new BundleRefusedError(`${MEMBERS_ENTRY} has a member with no email or a repeated one`);
  }
  const csv = csvEmails(membersCsv);
  if (csv.length !== members.length || !sameSet(csv, jsonEmails)) {
    throw new BundleRefusedError(
      `${MEMBERS_CSV_ENTRY} holds ${csv.length} members and ${MEMBERS_ENTRY} holds ${members.length}, or they are not the same people`
    );
  }
  const memberTiers = members.flatMap((m): ExpectedMemberTiers[] => {
    const tierSlugs = tierSlugsOf(m);
    return tierSlugs.length === 0
      ? []
      : [{ sourceId: typeof m.id === 'string' ? m.id : '', email: emailOf(m), tierSlugs }];
  });
  return {
    contentJson,
    membersCsv,
    counts: { ...contentRows(contentJson), members: members.length },
    memberTiers,
  };
}
