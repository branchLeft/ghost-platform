import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveFile } from './archive.js';
import {
  isMediaEntryName,
  isSafeMediaSegment,
  MEDIA_ENTRY_PREFIX,
  MEDIA_ROOTS,
} from './entryNames.js';
import type { ManifestMediaFile, MediaFilesListing } from './manifest.js';

/**
 * The media half of a demo's export: the originals Ghost's local storage
 * holds under `images`, `media` and `files` of the content directory, read
 * from the slot's content volume and carried in the encrypted bundle, so a
 * promotion has the bytes to import (the import goes through the tenant's own
 * Ghost and its storage adapters, never as copied files).
 *
 * What is carried is the served tree and nothing else:
 *
 * - resized variants (`images/size/...`) are never carried: Ghost makes them
 *   again on first request;
 * - the scanning decorator's quarantine directory and anything a hold has not
 *   released sit beside the three trees, not in them, so this walk never
 *   enters them;
 * - anything that is not a regular file refuses the export by name.
 *
 * This code only ever lstat()s, lists and opens for reading, and opens with
 * O_NOFOLLOW, so a path swapped for a link between the walk and the read is
 * refused as well.
 */

/** The destination tier's default upload ceiling: 128 MiB. */
export const DEFAULT_UPLOAD_CEILING_BYTES = 128 * 1024 * 1024;

/**
 * The bundle is built in memory (only ciphertext reaches disk), so what it
 * carries is bounded. A demo's media is small; more than this refuses the
 * export rather than exhausting the host.
 */
export const MAX_CARRIED_BYTES = 512 * 1024 * 1024;

export class MediaTreeRefusedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`refused: the media tree holds ${JSON.stringify(path)}, which is ${reason}`);
    this.name = 'MediaTreeRefusedError';
  }
}

export class MediaTreeTooLargeError extends Error {
  constructor(carriedBytes: number, limit: number) {
    super(
      `refused: the media to carry is ${String(carriedBytes)} bytes, over the ${String(limit)} the bundle holds in memory`
    );
    this.name = 'MediaTreeTooLargeError';
  }
}

interface TreeFile {
  /** Path below the content directory, `images/2026/a.png`. */
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
}

function describeKind(stats: Stats): string {
  if (stats.isSymbolicLink()) return 'a symbolic link';
  if (stats.isDirectory()) return 'a directory';
  if (stats.isFile()) return 'a regular file';
  if (stats.isBlockDevice() || stats.isCharacterDevice()) return 'a device';
  if (stats.isFIFO()) return 'a named pipe';
  if (stats.isSocket()) return 'a socket';
  return 'not a regular file';
}

async function walk(dir: string, rel: string, files: TreeFile[]): Promise<void> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const relPath = `${rel}/${dirent.name}`;
    // Resized variants: only the directory directly under `images`.
    if (relPath === 'images/size') continue;
    const abs = join(dir, dirent.name);
    const stats = await lstat(abs);
    if (stats.isDirectory()) {
      await walk(abs, relPath, files);
    } else if (stats.isFile()) {
      files.push({ rel: relPath, abs, size: stats.size });
    } else {
      throw new MediaTreeRefusedError(`content/${relPath}`, describeKind(stats));
    }
  }
}

async function listTree(contentDir: string): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  for (const root of MEDIA_ROOTS) {
    const abs = join(contentDir, root);
    let stats;
    try {
      stats = await lstat(abs);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') continue;
      throw err;
    }
    // A root that is a link would lead the whole walk out of the tree.
    if (!stats.isDirectory()) {
      throw new MediaTreeRefusedError(`content/${root}`, describeKind(stats));
    }
    await walk(abs, root, files);
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Reads one file for carrying, refusing a link or a non-file swapped in since the walk. */
async function readRegular(file: TreeFile): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ELOOP') {
      throw new MediaTreeRefusedError(`content/${file.rel}`, 'a symbolic link');
    }
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new MediaTreeRefusedError(`content/${file.rel}`, 'not a regular file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function hashRegular(file: TreeFile): Promise<{ size: number; sha256: string }> {
  let handle;
  try {
    handle = await open(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ELOOP') {
      throw new MediaTreeRefusedError(`content/${file.rel}`, 'a symbolic link');
    }
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new MediaTreeRefusedError(`content/${file.rel}`, 'not a regular file');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      hash.update(buffer);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** `images/2026/a.png` is a name the bundle can carry; a name outside the safe set is not. */
function carryable(rel: string): boolean {
  return (
    rel.split('/').slice(1).every(isSafeMediaSegment) &&
    isMediaEntryName(`${MEDIA_ENTRY_PREFIX}${rel}`)
  );
}

export interface MediaTreeResult {
  readonly listing: MediaFilesListing;
  /** The originals to put in the archive, one entry each, in listing order. */
  readonly files: readonly ArchiveFile[];
}

const SIZE_VARIANT = /^(images\/)size\/w\d+(?:h\d+)?\/(?:format\/[A-Za-z0-9]+\/)?/;

const REFERENCE = /__GHOST_URL__\/content\/((?:images|media|files)\/[^\s"'<>()\\?#]+)/g;

/**
 * The files the content references by site-relative address. A resized
 * address names the original it was made from. References are returned as
 * `images/2026/a.png`, decoded once.
 */
export function referencedMedia(contentJson: string): string[] {
  const found = new Set<string>();
  for (const match of contentJson.matchAll(REFERENCE)) {
    let rel = (match[1] ?? '').replace(/[.,;:!]+$/, '');
    try {
      rel = rel
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
    } catch {
      // Left as written: it will not be in the tree, and is listed by reference.
    }
    found.add(rel.replace(SIZE_VARIANT, '$1'));
  }
  return [...found].sort();
}

export interface ReadMediaTreeOptions {
  readonly contentDir: string;
  readonly uploadCeilingBytes: number;
  readonly contentJson: string;
  /** Test seam; defaults to `MAX_CARRIED_BYTES`. */
  readonly maxCarriedBytes?: number;
  /** Test seam: runs between the walk and the reads, where a path could be swapped. */
  readonly afterListing?: () => Promise<void>;
}

/**
 * Walks the tree and reads what the bundle carries. Throws
 * `MediaTreeRefusedError` for a link, a device or any other non-file; a caller
 * must let it end the export.
 */
export async function readMediaTree(options: ReadMediaTreeOptions): Promise<MediaTreeResult> {
  const tree = await listTree(options.contentDir);
  await options.afterListing?.();
  const listed: ManifestMediaFile[] = [];
  const unrepresentable: string[] = [];
  const archiveFiles: ArchiveFile[] = [];
  let carriedBytes = 0;
  for (const file of tree) {
    if (!carryable(file.rel)) {
      unrepresentable.push(`content/${file.rel}`);
      continue;
    }
    const path = `${MEDIA_ENTRY_PREFIX}${file.rel}`;
    if (file.size > options.uploadCeilingBytes) {
      const { size, sha256 } = await hashRegular(file);
      listed.push({ path, size, sha256, status: 'oversized' });
      continue;
    }
    const data = await readRegular(file);
    // The size read, not the size listed: a file that grew is listed as it was read.
    if (data.length > options.uploadCeilingBytes) {
      listed.push({
        path,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        status: 'oversized',
      });
      continue;
    }
    carriedBytes += data.length;
    if (carriedBytes > (options.maxCarriedBytes ?? MAX_CARRIED_BYTES)) {
      throw new MediaTreeTooLargeError(carriedBytes, options.maxCarriedBytes ?? MAX_CARRIED_BYTES);
    }
    listed.push({
      path,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      status: 'carried',
    });
    archiveFiles.push({ name: path, data });
  }
  const present = new Set(tree.map((f) => f.rel));
  const dangling = referencedMedia(options.contentJson)
    .filter((rel) => !present.has(rel))
    .map((rel) => `content/${rel}`);
  return {
    files: archiveFiles,
    listing: {
      uploadCeilingBytes: options.uploadCeilingBytes,
      treeFileCount: tree.length,
      files: listed,
      unrepresentable,
      danglingReferences: dangling,
    },
  };
}
