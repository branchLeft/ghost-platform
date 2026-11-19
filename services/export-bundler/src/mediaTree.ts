import { createHash } from 'node:crypto';
import type { ArchiveFile } from './archive.js';
import { isMediaEntryName, isSafeMediaSegment, MEDIA_ENTRY_PREFIX } from './entryNames.js';
import type { MediaTreeSource } from './mediaSource.js';
import type { ManifestMediaFile, MediaFilesListing } from './manifest.js';

/**
 * The media half of a demo's export: the originals Ghost's local storage
 * holds under `images`, `media` and `files` of the content directory, carried
 * in the encrypted bundle so a promotion has the bytes to import (the import
 * goes through the tenant's own Ghost and its storage adapters, never as
 * copied files).
 *
 * What is carried is the served tree and nothing else:
 *
 * - resized variants (`images/size/...`) are never carried: Ghost makes them
 *   again on first request;
 * - the scanning decorator's quarantine directory and anything a hold has not
 *   released sit beside the three trees, not in them, so the read never
 *   enters them;
 * - anything that is not a regular file refuses the export by name.
 *
 * The tree is read by `mediaSource.ts`, from a throwaway container that
 * mounts the volume read-only, never by this process walking host paths. The
 * live demo's Ghost can write to the volume while it is read, so what is read
 * is a snapshot of a tree that may still change: a file added or removed
 * during the read can be missing from it, and the manifest lists what was read.
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
  readonly source: MediaTreeSource;
  readonly uploadCeilingBytes: number;
  readonly contentJson: string;
  /** Test seam; defaults to `MAX_CARRIED_BYTES`. */
  readonly maxCarriedBytes?: number;
}

/**
 * Reads the tree through the source and works out what the bundle carries.
 * Throws `MediaTreeRefusedError` for a link, a device or any other non-file;
 * a caller must let it end the export.
 */
export async function readMediaTree(options: ReadMediaTreeOptions): Promise<MediaTreeResult> {
  const maxCarriedBytes = options.maxCarriedBytes ?? MAX_CARRIED_BYTES;
  const tree = [
    ...(await options.source.read({
      uploadCeilingBytes: options.uploadCeilingBytes,
      maxCarriedBytes,
    })),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
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
    if (file.data === null || file.data.length > options.uploadCeilingBytes) {
      listed.push({
        path,
        size: file.size,
        sha256:
          file.sha256 ??
          createHash('sha256')
            .update(file.data ?? '')
            .digest('hex'),
        status: 'oversized',
      });
      continue;
    }
    carriedBytes += file.data.length;
    if (carriedBytes > maxCarriedBytes)
      throw new MediaTreeTooLargeError(carriedBytes, maxCarriedBytes);
    listed.push({
      path,
      size: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      status: 'carried',
    });
    archiveFiles.push({ name: path, data: file.data });
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
